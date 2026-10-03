import Foundation

/// Where the server lives and how to run it. Each value can be overridden with
/// `defaults write com.bawaaaaah.wing-mcp-menubar <key> <value>`; otherwise it falls back to what
/// build-app.sh baked into Info.plist when the app was built from the checkout.
enum AppSettings {
  private static var defaults: UserDefaults { .standard }

  static var repoURL: URL {
    let path = defaults.string(forKey: "repoPath") ?? infoString("WingRepoPath") ?? ""
    return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
  }

  static var nodeURL: URL {
    let path = defaults.string(forKey: "nodePath") ?? infoString("WingNodePath") ?? "/usr/local/bin/node"
    return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
  }

  static var port: Int {
    let port = defaults.integer(forKey: "port")
    return port > 0 ? port : 8787
  }

  static var startServerOnLaunch: Bool {
    get { defaults.object(forKey: "startServerOnLaunch") as? Bool ?? true }
    set { defaults.set(newValue, forKey: "startServerOnLaunch") }
  }

  static var entryPointURL: URL { repoURL.appendingPathComponent("dist/index.js") }
  static var dataURL: URL { repoURL.appendingPathComponent("data", isDirectory: true) }
  static var logURL: URL { dataURL.appendingPathComponent("prod.log") }
  static var pidURL: URL { dataURL.appendingPathComponent("menubar.pid") }
  static var dashboardURL: URL { URL(string: "http://localhost:\(port)")! }

  /// `server.publicUrl` from data/config.json, unless it is just the localhost default.
  static func publicURL() -> URL? {
    guard
      let data = try? Data(contentsOf: dataURL.appendingPathComponent("config.json")),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let server = json["server"] as? [String: Any],
      let value = server["publicUrl"] as? String,
      let url = URL(string: value),
      let host = url.host,
      host != "localhost", host != "127.0.0.1"
    else { return nil }
    return url
  }

  /// The environment for node and npm: what the app inherited, with node's own directory first on
  /// PATH, because an app opened from the Finder or at login gets a bare /usr/bin:/bin.
  static func childEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let nodeDir = nodeURL.resolvingSymlinksInPath().deletingLastPathComponent().path
    let inherited = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    env["PATH"] = "\(nodeDir):\(nodeURL.deletingLastPathComponent().path):\(inherited)"
    env["PORT"] = String(port)
    return env
  }

  private static func infoString(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else {
      return nil
    }
    return value
  }
}
