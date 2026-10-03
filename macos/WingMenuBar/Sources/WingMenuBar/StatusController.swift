import AppKit
import ServiceManagement

/// The menu bar icon and its menu. The menu is rebuilt each time it opens; the icon follows every
/// state change.
@MainActor
final class StatusController: NSObject, NSMenuDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let supervisor = ServerSupervisor()
  private let health = HealthMonitor()
  private let builder = Builder()

  override init() {
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    statusItem.menu = menu

    supervisor.onChange = { [weak self] in
      guard let self else { return }
      if !self.supervisor.isRunning { self.health.reset() } else { self.health.check() }
      self.refreshIcon()
    }
    health.onChange = { [weak self] in self?.refreshIcon() }
    builder.onChange = { [weak self] in self?.refreshIcon() }
    refreshIcon()
  }

  func launch() {
    supervisor.adoptLeftoverServer()
    health.start()
    health.check { [weak self] status in
      guard let self, AppSettings.startServerOnLaunch, status == nil, !self.supervisor.isRunning else { return }
      self.startServer()
    }
  }

  func shutdown() {
    supervisor.stopAndWait()
  }

  // MARK: State

  private enum Display {
    case building, stopping, starting, running(String), restarting, crashed, external(String), stopped
  }

  private var display: Display {
    if builder.isBuilding && !supervisor.isRunning { return .building }
    switch supervisor.phase {
    case .stopping: return .stopping
    case .running: return health.status.map { .running($0) } ?? .starting
    case .waitingToRestart: return .restarting
    case .crashed: return .crashed
    case .stopped: return health.status.map { .external($0) } ?? .stopped
    }
  }

  private var statusText: String {
    var text: String
    switch display {
    case .building: text = "Building…"
    case .stopping: text = "Stopping…"
    case .starting: text = "Starting…"
    case .running(let status): text = "Running · \(status)"
    case .restarting: text = "Crashed, restarting…"
    case .crashed: text = "Crashed, see the logs"
    case .external(let status): text = "Running (external) · \(status)"
    case .stopped: text = "Stopped"
    }
    if builder.isBuilding, supervisor.isRunning { text += " · building…" }
    return text
  }

  private var isExternal: Bool {
    if case .external = display { return true }
    return false
  }

  private func refreshIcon() {
    guard let button = statusItem.button else { return }
    let symbol: String
    var dimmed = false
    switch display {
    case .running(let status) where status != "HEALTHY": symbol = "exclamationmark.triangle"
    case .crashed, .restarting: symbol = "exclamationmark.triangle"
    case .running, .external: symbol = "slider.vertical.3"
    case .building, .starting, .stopping: symbol = "arrow.triangle.2.circlepath"
    case .stopped:
      symbol = "slider.vertical.3"
      dimmed = true
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "WING MCP server")
    image?.isTemplate = true
    button.image = image
    button.appearsDisabled = dimmed
    button.toolTip = "WING MCP · \(statusText)"
  }

  // MARK: Menu

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    let header = NSMenuItem(title: "WING MCP · \(statusText)", action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    if let pid = supervisor.pid {
      let detail = NSMenuItem(title: "pid \(pid) · port \(AppSettings.port)", action: nil, keyEquivalent: "")
      detail.isEnabled = false
      menu.addItem(detail)
    }
    menu.addItem(.separator())

    let busy = builder.isBuilding || supervisor.phase == .stopping
    if supervisor.isRunning || supervisor.phase == .waitingToRestart {
      menu.addItem(item("Stop", #selector(stopServer), enabled: supervisor.phase != .stopping))
    } else {
      menu.addItem(item("Start", #selector(startServer), enabled: !busy && !isExternal))
    }
    menu.addItem(item("Restart", #selector(restartServer), enabled: !busy && !isExternal))
    menu.addItem(item("Rebuild & Restart", #selector(rebuildAndRestart), enabled: !busy && !isExternal))
    menu.addItem(.separator())

    menu.addItem(item("Open Dashboard", #selector(openDashboard), enabled: true))
    if let url = AppSettings.publicURL() {
      let publicItem = item("Open Public URL", #selector(openPublicURL), enabled: true)
      publicItem.toolTip = url.absoluteString
      menu.addItem(publicItem)
    }
    menu.addItem(item("Show Logs", #selector(showLogs), enabled: true))
    menu.addItem(.separator())

    let autoStart = item("Start Server When App Opens", #selector(toggleAutoStart), enabled: true)
    autoStart.state = AppSettings.startServerOnLaunch ? .on : .off
    menu.addItem(autoStart)
    let login = item("Open at Login", #selector(toggleOpenAtLogin), enabled: true)
    switch SMAppService.mainApp.status {
    case .enabled: login.state = .on
    case .requiresApproval: login.state = .mixed
    default: login.state = .off
    }
    menu.addItem(login)
    menu.addItem(.separator())

    menu.addItem(item("Quit (stops the server)", #selector(quit), enabled: true, key: "q"))
  }

  private func item(_ title: String, _ action: Selector, enabled: Bool, key: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
    item.target = self
    item.isEnabled = enabled
    return item
  }

  // MARK: Actions

  @objc private func startServer() {
    if FileManager.default.fileExists(atPath: AppSettings.entryPointURL.path) {
      supervisor.start()
    } else {
      rebuildAndRestart()
    }
  }

  @objc private func stopServer() {
    supervisor.stop()
  }

  @objc private func restartServer() {
    supervisor.restart()
  }

  /// The running server keeps serving during the build and is only restarted once it succeeds.
  @objc private func rebuildAndRestart() {
    builder.build { [weak self] success, tail in
      guard let self else { return }
      if success {
        self.supervisor.restart()
      } else {
        self.showAlert(title: "Build failed", text: tail)
      }
    }
  }

  @objc private func openDashboard() {
    NSWorkspace.shared.open(AppSettings.dashboardURL)
  }

  @objc private func openPublicURL() {
    if let url = AppSettings.publicURL() { NSWorkspace.shared.open(url) }
  }

  @objc private func showLogs() {
    let console = URL(fileURLWithPath: "/System/Applications/Utilities/Console.app")
    NSWorkspace.shared.open([AppSettings.logURL], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
  }

  @objc private func toggleAutoStart() {
    AppSettings.startServerOnLaunch.toggle()
  }

  @objc private func toggleOpenAtLogin() {
    let service = SMAppService.mainApp
    do {
      switch service.status {
      case .enabled: try service.unregister()
      case .requiresApproval: SMAppService.openSystemSettingsLoginItems()
      default: try service.register()
      }
    } catch {
      showAlert(title: "Could not change Open at Login", text: error.localizedDescription)
    }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func showAlert(title: String, text: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.alertStyle = .warning
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }
}
