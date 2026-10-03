import Foundation

/// Polls the server's anonymous `GET /health`, which answers `{"status":"HEALTHY"|"DEGRADED"|"ERROR"}`.
@MainActor
final class HealthMonitor {
  /// The last aggregate status, or nil when nothing answered on the port.
  private(set) var status: String?
  var onChange: (() -> Void)?

  private var timer: Timer?
  private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 2
    return URLSession(configuration: config)
  }()

  func start(interval: TimeInterval = 3) {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.check() }
    }
    check()
  }

  /// Forget the last answer, e.g. once our own process has exited, so a stale HEALTHY does not
  /// read as an external server for the next few seconds.
  func reset() {
    update(nil)
    check()
  }

  func check(completion: (@MainActor @Sendable (String?) -> Void)? = nil) {
    let url = URL(string: "http://127.0.0.1:\(AppSettings.port)/health")!
    session.dataTask(with: url) { data, response, _ in
      var status: String?
      if let data, (response as? HTTPURLResponse)?.statusCode == 200,
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        status = json["status"] as? String ?? "UNKNOWN"
      }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.update(status)
          completion?(status)
        }
      }
    }.resume()
  }

  private func update(_ newStatus: String?) {
    guard newStatus != status else { return }
    status = newStatus
    onChange?()
  }
}
