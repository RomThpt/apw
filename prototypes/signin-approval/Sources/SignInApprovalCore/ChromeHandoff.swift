import Foundation

public enum BrowserOpenResult: Equatable {
    case opened
    case unavailable
}

/// Opens a single URL in the target browser. The harness uses NSWorkspace with Google Chrome; tests inject a fake.
/// Implementations must return `.opened` only when the browser confirmed it accepted the URL.
public protocol BrowserOpener {
    func open(_ url: URL) async -> BrowserOpenResult
}

/// The only information the `--open-chrome` mode ever emits.
public enum HandoffOutcome: String {
    case browserOpened = "browser_opened"
    case denied
    case invalidRequest = "invalid_request"
    case unavailable
    case browserUnavailable = "browser_unavailable"

    public var exitCode: Int32 {
        switch self {
        case .browserOpened: return 0
        case .denied: return 1
        case .invalidRequest: return 2
        case .unavailable: return 3
        case .browserUnavailable: return 4
        }
    }

    /// Single-line JSON written to stdout.
    public var line: String {
        "{\"outcome\":\"\(rawValue)\"}"
    }
}

extension HTTPSOrigin {
    /// The origin as a URL whose serialization is byte-for-byte identical to the validated origin. Returns nil if
    /// Foundation would parse it into anything other than a bare HTTPS origin.
    public var canonicalURL: URL? {
        guard let url = URL(string: serialized),
              url.absoluteString == serialized,
              url.scheme == "https",
              url.user == nil, url.password == nil,
              url.path.isEmpty, url.query == nil, url.fragment == nil,
              let host = url.host, !host.isEmpty
        else {
            return nil
        }
        return url
    }
}

public enum ChromeHandoff {
    public static let chromeBundleIdentifier = "com.google.Chrome"

    /// Validates the request, asks the approver exactly once, and only on approval forwards the exact canonical origin
    /// URL to the opener. Invalid requests reach neither the approver nor the opener; denial or unavailable biometrics
    /// never reach the opener; an opener failure is reported as `browserUnavailable`, never as success.
    public static func evaluate(
        request: Data,
        approver: any SignInApprover,
        opener: any BrowserOpener
    ) async -> HandoffOutcome {
        let intent: SignInIntent
        do {
            intent = try SignInIntent.parse(request)
        } catch {
            return .invalidRequest
        }
        guard let url = intent.origin.canonicalURL else {
            return .invalidRequest
        }

        switch await approver.approve(ApprovalPrompt(chromeHandoffBinding: intent)) {
        case .denied: return .denied
        case .unavailable: return .unavailable
        case .approved: break
        }

        switch await opener.open(url) {
        case .opened: return .browserOpened
        case .unavailable: return .browserUnavailable
        }
    }
}
