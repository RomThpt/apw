// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SignInApproval",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "signin-approval-harness", targets: ["SignInApprovalHarness"]),
    ],
    targets: [
        // Platform-neutral request validation, prompt binding and outcome mapping. No LocalAuthentication here so the
        // logic can be exercised with an injected fake approver.
        .target(name: "SignInApprovalCore"),
        // Thin executable that wires the core to the native Touch ID approver.
        .executableTarget(name: "SignInApprovalHarness", dependencies: ["SignInApprovalCore"]),
        .testTarget(name: "SignInApprovalCoreTests", dependencies: ["SignInApprovalCore"]),
    ]
)
