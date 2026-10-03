import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var controller: StatusController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let controller = StatusController()
    self.controller = controller
    controller.launch()
  }

  /// The server is a child of this app: quitting the app stops it rather than leaving it orphaned.
  func applicationWillTerminate(_ notification: Notification) {
    controller?.shutdown()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
