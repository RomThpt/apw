import Foundation
import SignInApprovalCore

func readRequest(from input: FileHandle) throws -> Data {
    var request = Data()
    let limit = SignInIntent.maxRequestBytes + 1
    while request.count < limit {
        guard let chunk = try input.read(upToCount: limit - request.count), !chunk.isEmpty else { break }
        request.append(chunk)
    }
    return request
}

let arguments = Array(CommandLine.arguments.dropFirst())
let line: String
let exitCode: Int32
if arguments.isEmpty {
    // Default mode: approval only, never opens a browser.
    let outcome: Outcome
    if let request = try? readRequest(from: .standardInput) {
        outcome = await SignInApprovalHarness.evaluate(request: request, approver: BiometricApprover())
    } else {
        outcome = .invalidRequest
    }
    line = outcome.line
    exitCode = outcome.exitCode
} else if arguments == ["--open-chrome"] {
    let outcome: HandoffOutcome
    if let request = try? readRequest(from: .standardInput) {
        outcome = await ChromeHandoff.evaluate(request: request, approver: BiometricApprover(), opener: ChromeOpener())
    } else {
        outcome = .invalidRequest
    }
    line = outcome.line
    exitCode = outcome.exitCode
} else {
    line = Outcome.invalidRequest.line
    exitCode = Outcome.invalidRequest.exitCode
}

FileHandle.standardOutput.write(Data((line + "\n").utf8))
exit(exitCode)
