import Foundation

/// Owns the `node dist/index.js` child: starts it, stops it (SIGTERM, then SIGKILL after 5 s) and
/// restarts it when it dies on its own. It never signals a process it did not start — except one it
/// started in an earlier run of the app, recognised through data/menubar.pid.
@MainActor
final class ServerSupervisor {
  enum Phase: Equatable {
    case stopped
    case running
    case stopping
    /// Died on its own; a restart is scheduled.
    case waitingToRestart
    /// Died too often in a row; left stopped until the user acts.
    case crashed
  }

  private(set) var phase: Phase = .stopped
  private(set) var pid: pid_t?
  var onChange: (() -> Void)?

  private var process: Process?
  /// A server started by a previous run of the app; watched by polling since it is not our child.
  private var adoptedPID: pid_t?
  private var adoptedWatch: Timer?
  private var wantRunning = false
  private var crashTimes: [Date] = []
  private var restartWork: DispatchWorkItem?
  private var stopCompletions: [() -> Void] = []

  private static let restartDelays: [TimeInterval] = [1, 2, 5, 10]
  private static let crashLimit = 5
  private static let crashWindow: TimeInterval = 60

  var isRunning: Bool { phase == .running || phase == .stopping }

  // MARK: Start

  func start() {
    guard process == nil, adoptedPID == nil else { return }
    restartWork?.cancel()
    wantRunning = true

    let log = LogFile.open()
    log?.write(line: "[menubar] starting node dist/index.js on port \(AppSettings.port)")

    let process = Process()
    process.executableURL = AppSettings.nodeURL
    process.arguments = ["dist/index.js"]
    process.currentDirectoryURL = AppSettings.repoURL
    process.environment = AppSettings.childEnvironment()
    process.standardInput = FileHandle.nullDevice
    if let handle = log?.handle {
      process.standardOutput = handle
      process.standardError = handle
    }
    process.terminationHandler = { finished in
      let status = finished.terminationStatus
      let reason = finished.terminationReason
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self.processExited(status: status, reason: reason) }
      }
    }

    do {
      try process.run()
    } catch {
      log?.write(line: "[menubar] could not start node: \(error.localizedDescription)")
      try? log?.close()
      recordCrash()
      return
    }
    // The child holds its own copy of the descriptor.
    try? log?.close()

    self.process = process
    pid = process.processIdentifier
    try? String(process.processIdentifier).write(to: AppSettings.pidURL, atomically: true, encoding: .utf8)
    setPhase(.running)
  }

  /// Take back a server a previous run of the app left behind (the app crashed or was killed).
  func adoptLeftoverServer() {
    guard
      process == nil, adoptedPID == nil,
      let text = try? String(contentsOf: AppSettings.pidURL, encoding: .utf8),
      let leftover = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)),
      kill(leftover, 0) == 0,
      commandLine(of: leftover).contains("dist/index.js")
    else {
      try? FileManager.default.removeItem(at: AppSettings.pidURL)
      return
    }
    adoptedPID = leftover
    pid = leftover
    wantRunning = true
    adoptedWatch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, let adopted = self.adoptedPID, kill(adopted, 0) != 0 else { return }
        self.processExited(status: -1, reason: .uncaughtSignal)
      }
    }
    setPhase(.running)
  }

  // MARK: Stop

  func stop(completion: (() -> Void)? = nil) {
    wantRunning = false
    restartWork?.cancel()
    restartWork = nil

    guard let target = pid else {
      if phase != .stopped { setPhase(.stopped) }
      completion?()
      return
    }
    if let completion { stopCompletions.append(completion) }
    guard phase != .stopping else { return }
    setPhase(.stopping)

    LogFile.append(line: "[menubar] stopping server (pid \(target))")
    kill(target, SIGTERM)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.pid == target, kill(target, 0) == 0 else { return }
        LogFile.append(line: "[menubar] server ignored SIGTERM for 5 s, sending SIGKILL")
        kill(target, SIGKILL)
      }
    }
  }

  func restart() {
    stop { [weak self] in self?.start() }
  }

  /// Blocks until the server is gone, for the app's own termination path.
  func stopAndWait(timeout: TimeInterval = 6) {
    guard let target = pid else { return }
    stop()
    let deadline = Date().addingTimeInterval(timeout)
    while kill(target, 0) == 0 && Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
  }

  // MARK: Exit handling

  private func processExited(status: Int32, reason: Process.TerminationReason) {
    process = nil
    adoptedPID = nil
    adoptedWatch?.invalidate()
    adoptedWatch = nil
    pid = nil
    try? FileManager.default.removeItem(at: AppSettings.pidURL)

    let completions = stopCompletions
    stopCompletions = []

    if wantRunning {
      let how = reason == .uncaughtSignal ? "was killed by signal \(status)" : "exited with status \(status)"
      LogFile.append(line: "[menubar] server \(how) unexpectedly")
      recordCrash()
    } else {
      LogFile.append(line: "[menubar] server stopped")
      setPhase(.stopped)
    }
    completions.forEach { $0() }
  }

  private func recordCrash() {
    let now = Date()
    crashTimes = crashTimes.filter { now.timeIntervalSince($0) < Self.crashWindow } + [now]
    guard crashTimes.count < Self.crashLimit else {
      LogFile.append(line: "[menubar] \(crashTimes.count) crashes in \(Int(Self.crashWindow)) s, giving up")
      wantRunning = false
      crashTimes = []
      setPhase(.crashed)
      return
    }
    let delay = Self.restartDelays[min(crashTimes.count - 1, Self.restartDelays.count - 1)]
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.wantRunning else { return }
        self.start()
      }
    }
    restartWork = work
    setPhase(.waitingToRestart)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func setPhase(_ newPhase: Phase) {
    phase = newPhase
    onChange?()
  }

  private func commandLine(of pid: pid_t) -> String {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-o", "command=", "-p", String(pid)]
    let pipe = Pipe()
    ps.standardOutput = pipe
    ps.standardError = FileHandle.nullDevice
    guard (try? ps.run()) != nil else { return "" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    ps.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
  }
}

/// data/prod.log, opened in append mode so the server, the build and the app can all write to it.
final class LogFile: @unchecked Sendable {
  let handle: FileHandle

  private init(handle: FileHandle) { self.handle = handle }

  static func open() -> LogFile? {
    try? FileManager.default.createDirectory(at: AppSettings.dataURL, withIntermediateDirectories: true)
    let fd = Darwin.open(AppSettings.logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard fd >= 0 else { return nil }
    return LogFile(handle: FileHandle(fileDescriptor: fd, closeOnDealloc: true))
  }

  static func append(line: String) {
    guard let log = open() else { return }
    log.write(line: line)
    try? log.close()
  }

  func write(line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    write(Data("\(stamp) \(line)\n".utf8))
  }

  func write(_ data: Data) {
    try? handle.write(contentsOf: data)
  }

  func close() throws {
    try handle.close()
  }
}
