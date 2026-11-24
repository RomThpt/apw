import Foundation
import LocalAuthentication
import SignInApprovalCore

/// Shows the native Touch ID sheet with the bound origin and account. Biometrics only: the password fallback button is
/// hidden and `deviceOwnerAuthenticationWithBiometrics` never falls back to the login password.
struct BiometricApprover: SignInApprover {
    func approve(_ prompt: ApprovalPrompt) async -> ApprovalDecision {
        let context = LAContext()
        defer { context.invalidate() }
        context.localizedFallbackTitle = ""
        context.localizedCancelTitle = "Deny"

        var availabilityError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &availabilityError) else {
            return .unavailable
        }

        do {
            let approved = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: prompt.reason
            )
            return approved ? .approved : .denied
        } catch let error as LAError {
            switch error.code {
            case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
                return .unavailable
            default:
                // User cancel, system cancel, app cancel, failed match, not interactive, and anything unknown.
                return .denied
            }
        } catch {
            return .denied
        }
    }
}
