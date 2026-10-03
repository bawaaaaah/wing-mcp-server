import Foundation

/// Runs `npm run build` in the checkout. Output goes to data/prod.log and is kept so a failure can
/// show its last lines.
@MainActor
final class Builder {
  private(set) var isBuilding = false
  var onChange: (() -> Void)?

  func build(completion: @escaping @MainActor @Sendable (_ success: Bool, _ outputTail: String) -> Void) {
    guard !isBuilding else { return }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["npm", "run", "build"]
    process.currentDirectoryURL = AppSettings.repoURL
    process.environment = AppSettings.childEnvironment()

    let log = LogFile.open()
    log?.write(line: "[menubar] npm run build")
    let output = OutputBuffer()
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      guard !chunk.isEmpty else { return }
      output.append(chunk)
      log?.write(chunk)
    }

    process.terminationHandler = { finished in
      pipe.fileHandleForReading.readabilityHandler = nil
      output.append(pipe.fileHandleForReading.readDataToEndOfFile())
      let success = finished.terminationReason == .exit && finished.terminationStatus == 0
      log?.write(line: "[menubar] build \(success ? "succeeded" : "failed (\(finished.terminationStatus))")")
      try? log?.close()
      let tail = output.tail(lines: 20)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.isBuilding = false
          self.onChange?()
          completion(success, tail)
        }
      }
    }

    do {
      try process.run()
    } catch {
      try? log?.close()
      completion(false, "Could not run npm: \(error.localizedDescription)")
      return
    }
    isBuilding = true
    onChange?()
  }
}

/// Collects a child's output from the pipe's background queue.
private final class OutputBuffer: @unchecked Sendable {
  private var data = Data()
  private let lock = NSLock()

  func append(_ chunk: Data) {
    lock.lock()
    data.append(chunk)
    lock.unlock()
  }

  func tail(lines count: Int) -> String {
    lock.lock()
    defer { lock.unlock() }
    let text = String(decoding: data, as: UTF8.self)
    return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(count).joined(separator: "\n")
  }
}
