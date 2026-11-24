import AppKit
import Foundation
import SignInApprovalCore

/// Opens one URL in the installed Google Chrome app, resolved by bundle identifier through Launch Services. Reads no
/// browser data and runs no scripts; it only hands the URL to NSWorkspace.
struct ChromeOpener: BrowserOpener {
    func open(_ url: URL) async -> BrowserOpenResult {
        let workspace = NSWorkspace.shared
        guard let appURL = workspace.urlForApplication(withBundleIdentifier: ChromeHandoff.chromeBundleIdentifier) else {
            return .unavailable
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.promptsUserIfNeeded = false
        configuration.addsToRecentItems = false

        return await withCheckedContinuation { continuation in
            workspace.open([url], withApplicationAt: appURL, configuration: configuration) { application, error in
                guard error == nil,
                      let application,
                      application.bundleIdentifier == ChromeHandoff.chromeBundleIdentifier
                else {
                    continuation.resume(returning: .unavailable)
                    return
                }
                continuation.resume(returning: .opened)
            }
        }
    }
}
