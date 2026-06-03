import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 2026-06-03 — FirebaseApp.configure() is NOT called here for v1.
        // The @capacitor-firebase/messaging plugin (which brought Firebase
        // iOS SDK pods into the project) was uninstalled to resolve a
        // firebase v10/v12 cross-version conflict that was crashing
        // WKWebView with a TDZ in the JS bundle. With the plugin gone,
        // FirebaseCore is no longer linked - adding `import FirebaseCore`
        // would fail the Xcode compile.
        //
        // For v1.1 push wiring (Capacitor @capacitor/push-notifications +
        // direct APNs from Cloud Function via node-apn), Firebase iOS SDK
        // is not needed at all. APNs registration goes through the
        // standard UIApplication.registerForRemoteNotifications path the
        // Capacitor plugin handles, and the Cloud Function talks APNs
        // HTTP/2 directly with the existing Auth Key.
        //
        // If we ever go back to FCM-via-Firebase-iOS-SDK, add the
        // firebase-ios-sdk SPM dependency to the App target, re-add
        // `import FirebaseCore` here, and call FirebaseApp.configure().
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // 2026-06-03 ROOT-CAUSE FIX — bridge APNs token from iOS to the
    // @capacitor/push-notifications plugin.
    //
    // Symptom before this: plugin.register() called UIApplication.
    // registerForRemoteNotifications() successfully (we saw the call in
    // Safari console), iOS contacted APNs and got a token back, but
    // the 'registration' JS event NEVER fired → timeout after 15000ms
    // → push registration aborted silently.
    //
    // Root cause: iOS's UIApplicationDelegate has 2 callback methods
    // (didRegister... / didFailToRegister...) that fire when APNs
    // returns. Capacitor's plugin listens for NotificationCenter posts
    // on .capacitorDidRegisterForRemoteNotifications and
    // .capacitorDidFailToRegisterForRemoteNotifications to translate
    // those into the JS-side 'registration' / 'registrationError'
    // events. Without these AppDelegate methods, iOS gets the token
    // but the Capacitor plugin never knows about it.
    //
    // The default Capacitor app template includes these methods, but
    // ours got stripped (probably during the @capacitor-firebase/
    // messaging install/uninstall churn) and we never put them back.
    //
    // Reference: https://capacitorjs.com/docs/apis/push-notifications
    // — "Add the following to your AppDelegate.swift" section.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
