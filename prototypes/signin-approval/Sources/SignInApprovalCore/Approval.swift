import Foundation

/// The exact text an approver must display. Built only from a validated `SignInIntent`, so the origin and account
/// shown to the user are the same values that passed validation.
public struct ApprovalPrompt: Equatable {
    public let origin: String
    public let account: String
    public let reason: String

    init(binding intent: SignInIntent) {
        origin = intent.origin.serialized
        account = intent.account.value
        reason = "Approve a test sign-in to \(origin) for account \(account)"
    }

    /// Prompt for the `--open-chrome` handoff. States the exact origin and account, and that approving opens Google
    /// Chrome where the user selects the account through official iCloud Passwords.
    init(chromeHandoffBinding intent: SignInIntent) {
        origin = intent.origin.serialized
        account = intent.account.value
        reason = "Approve opening \(origin) in Google Chrome for account \(account). "
            + "You will select the account in Chrome using official iCloud Passwords."
    }
}

public enum ApprovalDecision: Equatable {
    case approved
    case denied
    case unavailable
}

/// Presents an `ApprovalPrompt` to the device owner. The harness uses Touch ID; tests inject a fake.
public protocol SignInApprover {
    func approve(_ prompt: ApprovalPrompt) async -> ApprovalDecision
}

/// The only information the harness ever emits.
public enum Outcome: String {
    case approved
    case denied
    case invalidRequest = "invalid_request"
    case unavailable

    public var exitCode: Int32 {
        switch self {
        case .approved: return 0
        case .denied: return 1
        case .invalidRequest: return 2
        case .unavailable: return 3
        }
    }

    /// Single-line JSON written to stdout.
    public var line: String {
        "{\"outcome\":\"\(rawValue)\"}"
    }
}

public enum SignInApprovalHarness {
    /// Validates the request and, only if it is valid, asks the approver. Invalid requests never reach the approver.
    public static func evaluate(request: Data, approver: any SignInApprover) async -> Outcome {
        let intent: SignInIntent
        do {
            intent = try SignInIntent.parse(request)
        } catch {
            return .invalidRequest
        }
        switch await approver.approve(ApprovalPrompt(binding: intent)) {
        case .approved: return .approved
        case .denied: return .denied
        case .unavailable: return .unavailable
        }
    }
}
