import Foundation
import SignInApprovalCore
import XCTest

final class ChromeHandoffTests: XCTestCase {
    func testApprovedHandoffForwardsExactOriginOnceAndReportsBrowserOpened() async throws {
        for origin in ["https://login.example.test", "https://login.example.test:8443"] {
            let approver = FakeApprover(.approved)
            let opener = FakeOpener(.opened)

            let outcome = await ChromeHandoff.evaluate(
                request: try makeRequest(origin: origin, account: "demo@example.test"),
                approver: approver,
                opener: opener
            )

            XCTAssertEqual(outcome, .browserOpened, origin)
            XCTAssertEqual(outcome.line, #"{"outcome":"browser_opened"}"#)
            XCTAssertEqual(outcome.exitCode, 0)

            XCTAssertEqual(approver.prompts.count, 1, origin)
            let prompt = try XCTUnwrap(approver.prompts.first)
            XCTAssertEqual(prompt.origin, origin)
            XCTAssertEqual(prompt.account, "demo@example.test")
            XCTAssertEqual(
                prompt.reason,
                "Approve opening \(origin) in Google Chrome for account demo@example.test. "
                    + "You will select the account in Chrome using official iCloud Passwords."
            )

            XCTAssertEqual(opener.urls.count, 1, origin)
            let url = try XCTUnwrap(opener.urls.first)
            XCTAssertEqual(url.absoluteString, origin)
            XCTAssertEqual(url.scheme, "https")
            XCTAssertEqual(url.path, "")
            XCTAssertNil(url.query)
            XCTAssertNil(url.fragment)
        }
    }

    func testBrowserFailureIsNeverReportedAsSuccess() async throws {
        let approver = FakeApprover(.approved)
        let opener = FakeOpener(.unavailable)

        let outcome = await ChromeHandoff.evaluate(request: try makeRequest(), approver: approver, opener: opener)

        XCTAssertEqual(outcome, .browserUnavailable)
        XCTAssertNotEqual(outcome, .browserOpened)
        XCTAssertEqual(outcome.line, #"{"outcome":"browser_unavailable"}"#)
        XCTAssertEqual(outcome.exitCode, 4)
        XCTAssertEqual(approver.prompts.count, 1)
        XCTAssertEqual(opener.urls.map(\.absoluteString), ["https://login.example.test"])
    }

    func testDeniedAndUnavailableBiometricsNeverOpenTheBrowser() async throws {
        let request = try makeRequest()

        let deniedApprover = FakeApprover(.denied)
        let deniedOpener = FakeOpener(.opened)
        let denied = await ChromeHandoff.evaluate(request: request, approver: deniedApprover, opener: deniedOpener)
        XCTAssertEqual(denied.line, #"{"outcome":"denied"}"#)
        XCTAssertEqual(denied.exitCode, 1)
        XCTAssertEqual(deniedApprover.prompts.count, 1)
        XCTAssertTrue(deniedOpener.urls.isEmpty)

        let unavailableApprover = FakeApprover(.unavailable)
        let unavailableOpener = FakeOpener(.opened)
        let unavailable = await ChromeHandoff.evaluate(
            request: request, approver: unavailableApprover, opener: unavailableOpener
        )
        XCTAssertEqual(unavailable.line, #"{"outcome":"unavailable"}"#)
        XCTAssertEqual(unavailable.exitCode, 3)
        XCTAssertEqual(unavailableApprover.prompts.count, 1)
        XCTAssertTrue(unavailableOpener.urls.isEmpty)
    }

    func testInvalidRequestsReachNeitherApproverNorBrowser() async throws {
        let approver = FakeApprover(.approved)
        let opener = FakeOpener(.opened)
        var requests = [
            Data(), Data(repeating: 32, count: SignInIntent.maxRequestBytes + 1), Data("not json".utf8),
            Data(#"{"origin":"https://login.example.test","account":"demo","extra":false}"#.utf8),
            Data(#"{"origin":"https://login.example.test","account":123}"#.utf8),
            Data(#"{"origin":"https://login.example.test"}"#.utf8),
            try makeRequest(account: "demo\nother"), try makeRequest(account: "demo\u{202E}other"),
            try makeRequest(account: "")
        ]
        for origin in [
            "http://login.example.test", "https://login.example.test/path", "https://login.example.test/",
            "https://login.example.test?account=demo", "https://login.example.test#login",
            "https://login.example.test@other.example.test", "https://login.example.test:443",
            "https://login.example.test:65536", "https://127.0.0.1", "https://[::1]",
            "https://Login.example.test", "https://login.example.test.", "javascript:alert(1)",
            "file:///etc/hosts", "chrome://settings"
        ] {
            requests.append(try makeRequest(origin: origin))
        }

        for request in requests {
            let outcome = await ChromeHandoff.evaluate(request: request, approver: approver, opener: opener)
            XCTAssertEqual(outcome.line, #"{"outcome":"invalid_request"}"#)
            XCTAssertEqual(outcome.exitCode, 2)
        }
        XCTAssertTrue(approver.prompts.isEmpty)
        XCTAssertTrue(opener.urls.isEmpty)
    }

    func testDefaultModeIsUnchangedAndNeverMentionsChrome() async throws {
        let approver = FakeApprover(.approved)

        let outcome = await SignInApprovalHarness.evaluate(request: try makeRequest(), approver: approver)

        XCTAssertEqual(outcome, .approved)
        XCTAssertEqual(outcome.line, #"{"outcome":"approved"}"#)
        XCTAssertEqual(outcome.exitCode, 0)
        let prompt = try XCTUnwrap(approver.prompts.first)
        XCTAssertEqual(prompt.reason, "Approve a test sign-in to https://login.example.test for account demo")
        XCTAssertFalse(prompt.reason.contains("Chrome"))
    }

    func testHandoffOutcomesAndBrowserIdentityAreFixed() {
        let expected: [(HandoffOutcome, String, Int32)] = [
            (.browserOpened, #"{"outcome":"browser_opened"}"#, 0),
            (.denied, #"{"outcome":"denied"}"#, 1),
            (.invalidRequest, #"{"outcome":"invalid_request"}"#, 2),
            (.unavailable, #"{"outcome":"unavailable"}"#, 3),
            (.browserUnavailable, #"{"outcome":"browser_unavailable"}"#, 4)
        ]
        for (outcome, line, exitCode) in expected {
            XCTAssertEqual(outcome.line, line)
            XCTAssertEqual(outcome.exitCode, exitCode)
        }
        XCTAssertEqual(ChromeHandoff.chromeBundleIdentifier, "com.google.Chrome")
    }

    private func makeRequest(origin: String = "https://login.example.test", account: String = "demo") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["origin": origin, "account": account])
    }
}

private final class FakeApprover: SignInApprover {
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

private final class FakeOpener: BrowserOpener {
    private let result: BrowserOpenResult
    private(set) var urls: [URL] = []

    init(_ result: BrowserOpenResult) {
        self.result = result
    }

    func open(_ url: URL) async -> BrowserOpenResult {
        urls.append(url)
        return result
    }
}
