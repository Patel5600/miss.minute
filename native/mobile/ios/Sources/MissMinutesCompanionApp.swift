import BackgroundTasks
import SwiftUI

@main
struct MissMinutesCompanionApp: App {
    @UIApplicationDelegateAdaptor(CompanionAppDelegate.self) private var appDelegate
    @StateObject private var model = CompanionModel()

    var body: some Scene {
        WindowGroup {
            CompanionView(model: model)
        }
    }
}

final class CompanionAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: MetadataRefresh.taskIdentifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            MetadataRefresh.handle(refreshTask)
        }
        if !registered {
            NSLog("[MissMinutes] Background refresh registration failed.")
        }
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        MetadataRefresh.scheduleNext()
    }
}
