import SwiftUI
import UIKit

/// The channel manager must exist as early as possible, including when the system
/// launches the app in the background for an incoming push (no scene, no UI).
/// So startup lives in the app delegate, not in a view.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Task { @MainActor in LabModel.shared.start() }
        return true
    }
}

@main
struct ChirpLabApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            HarnessView(model: LabModel.shared)
        }
    }
}
