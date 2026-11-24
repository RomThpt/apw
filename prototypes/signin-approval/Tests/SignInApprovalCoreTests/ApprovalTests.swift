import Foundation
import SignInApprovalCore
import XCTest

final class ApprovalTests: XCTestCase {
    func testApprovedPromptBindsExactOriginAndAccount() async throws {
        let approver = RecordingApprover(.approved)
        let request = try makeRequest(origin: "https://login.example.test:8443", account: "demo@example.test")

        let outcome = await SignInApprovalHarness.evaluate(request: request, approver: approver)

        XCTAssertEqual(outcome, .approved)
        XCTAssertEqual(outcome.line, #"{"outcome":"approved"}"#)
        XCTAssertEqual(outcome.exitCode, 0)
        XCTAssertEqual(approver.prompts.count, 1)
        let prompt = try XCTUnwrap(approver.prompts.first)
        XCTAssertEqual(prompt.origin, "https://login.example.test:8443")
        XCTAssertEqual(prompt.account, "demo@example.test")
        XCTAssertEqual(prompt.reason, "Approve a test sign-in to https://login.example.test:8443 for account demo@example.test")
    }

    func testDenialAndUnavailableBiometricsFailClosed() async throws {
        let request = try makeRequest()
        let denied = await SignInApprovalHarness.evaluate(request: request, approver: RecordingApprover(.denied))
        let unavailable = await SignInApprovalHarness.evaluate(request: request, approver: RecordingApprover(.unavailable))

        XCTAssertEqual(denied.line, #"{"outcome":"denied"}"#)
        XCTAssertEqual(denied.exitCode, 1)
        XCTAssertEqual(unavailable.line, #"{"outcome":"unavailable"}"#)
        XCTAssertEqual(unavailable.exitCode, 3)
    }

    func testNonOriginAndAmbiguousHostsAreRejectedBeforeApproval() async throws {
        let approver = RecordingApprover(.approved)
        let origins = [
            "http://login.example.test", "https://login.example.test/path", "https://login.example.test/",
            "https://login.example.test?account=demo", "https://login.example.test#login",
            "https://login.example.test@other.example.test", "https://login.example.test:443",
            "https://login.example.test:65536", "https://127.0.0.1", "https://127.0.0.0x1",
            "https://[::1]", "https://Login.example.test", "https://login.example.test."
        ]

        for origin in origins {
            let outcome = await SignInApprovalHarness.evaluate(request: try makeRequest(origin: origin), approver: approver)
            XCTAssertEqual(outcome, .invalidRequest, origin)
        }
        XCTAssertTrue(approver.prompts.isEmpty)
    }

    func testMalformedRequestsAndHiddenAccountCharactersAreRejected() async throws {
        let approver = RecordingApprover(.approved)
        let requests = [
            Data(), Data(repeating: 32, count: SignInIntent.maxRequestBytes + 1),
            Data(#"{"origin":"https://login.example.test","account":"demo","extra":false}"#.utf8),
            Data(#"{"origin":"https://login.example.test","account":123}"#.utf8),
            try makeRequest(account: "demo\nother"), try makeRequest(account: "demo\u{202E}other"),
            try makeRequest(account: String(repeating: "a", count: AccountIdentifier.maxLength + 1))
        ]

        for request in requests {
            let outcome = await SignInApprovalHarness.evaluate(request: request, approver: approver)
            XCTAssertEqual(outcome.line, #"{"outcome":"invalid_request"}"#)
            XCTAssertEqual(outcome.exitCode, 2)
        }
        XCTAssertTrue(approver.prompts.isEmpty)
    }

    private func makeRequest(origin: String = "https://login.example.test", account: String = "demo") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["origin": origin, "account": account])
    }
}

private final class RecordingApprover: SignInApprover {
    private let decision: ApprovalDecision
    private(set) var prompts: [ApprovalPrompt] = []

    init(_ decision: ApprovalDecision) {
        self.decision = decision
    }

    func approve(_ prompt: ApprovalPrompt) async -> ApprovalDecision {
        prompts.append(prompt)
        return decision
    }
}
