// swift-tools-version: 6.0
import PackageDescription

// Platform-neutral core for the Phase 00B lab: the wire protocol and the
// transmission state machine. No Apple PTT, UIKit or audio APIs live here, so
// everything is unit-testable on a Mac and reusable by other platforms.
let package = Package(
    name: "ChirpCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ChirpCore", targets: ["ChirpCore"])],
    targets: [
        .target(name: "ChirpCore"),
        .testTarget(name: "ChirpCoreTests", dependencies: ["ChirpCore"]),
    ]
)
