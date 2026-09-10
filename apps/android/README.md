# Synara for Android

Android packages the same React application as the desktop app. Desktop feature changes belong in apps/web and reach Android on the next Android build. There is no second transcript renderer, Kotlin RPC client, or manually translated screen tree.

## Ownership

| Area | Source |
| --- | --- |
| Screens, settings, actions, streaming, reconnects | apps/web/src |
| Phone navigation and layout | apps/web/src/components/phone |
| Platform-independent contracts | packages/contracts |
| Shared runtime utilities | packages/shared |
| Native session storage | app/src/main/java/com/synara/android |
| Native adapter | apps/web/src/shellBridge.ts |
| Android lifecycle, back, and incoming links | apps/web/src/mobileRuntime.ts |
| Notification presentation and file exports | apps/web/src/mobileNotifications.ts and mobileDownloads.ts |

Keep viewport layout separate from platform detection. A narrow desktop window uses phone layout; an Android tablet can use the wider layout. Native integrations must not reimplement server or feature behavior.

## Build

Install Bun 1.4.2, Node 24, Java 21, and an Android SDK with platform 36 and build tools 36.0.0. Set ANDROID_HOME and JAVA_HOME for your local toolchain.

From the repository root:

    bun install --frozen-lockfile
    bun run build:android

The debug APK is at apps/android/app/build/outputs/apk/debug/app-debug.apk.

For an Android Studio session:

    bun run --cwd apps/android prepare:android

Then open apps/android in Android Studio. Repeat preparation after changing shared source. Generated web assets and Capacitor configuration are ignored by Git. Android mode only changes packaging: it omits the web server's gzip/Brotli sidecars, which Android's asset packager treats as duplicate files.

Native checks:

    cd apps/android
    ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleRelease
    ./gradlew :app:connectedDebugAndroidTest

The connected tests require a dedicated emulator or test device. They reset this app's saved pairing. CI compiles the shared renderer, checks Android builds, and exercises the native bridge on an emulator.

## Release

The application ID remains com.synara.android. Use the same signing key as an earlier installation to preserve its app data. The native store retains the previous app's Keystore alias and encrypted preference format.

Set these environment variables in the release environment:

- SYNARA_ANDROID_KEYSTORE: path to the existing signing keystore
- SYNARA_ANDROID_STORE_PASSWORD
- SYNARA_ANDROID_KEY_ALIAS
- SYNARA_ANDROID_KEY_PASSWORD

Then run:

    bun run dist:android

The bundle is at apps/android/app/build/outputs/bundle/release/app-release.aab. Without signing variables, builds are unsigned verification artifacts. Do not commit signing material.

## Connections and device behavior

The privileged shell loads bundled assets from https://app.synara.local. It never loads the paired server's website. Pairing and feature RPCs go to the selected server over HTTPS/WSS.

Use the secure remote-access URL from the server, including a trusted HTTPS tunnel for a LAN-only server. Plain HTTP pairings from the previous app must be replaced with an HTTPS pairing; the saved record is not silently deleted. Certificate errors are not bypassed.

A synara://pair link prefills the shared connect screen. The user still submits the pairing form. Credentials stay in memory until the native secure store saves the resulting session; pairing tokens are not put in navigation history.

Android Back first dismisses a shared popup, then navigates app history, then backgrounds the app at its root. Returning to the foreground wakes the existing shared transport.

File exports use Android's share sheet. Files are written to app cache in bounded chunks; old exports expire on a later launch or export after 24 hours.

## Release limitations

This migration removes the duplicate app and establishes shared feature ownership. It is not a certification that every desktop workflow is ready to ship on every Android device.

- Notifications use the shared desktop event detection and Android notification presentation. They may stop when Android suspends or terminates the WebView. Reliable delivery while the app is stopped requires server push, which is not implemented. The old indefinite dataSync foreground service is removed.
- Desktop-only OS integrations still require an Android capability adapter where an Android equivalent makes sense.
- Before distribution, verify pairing with a real HTTPS server, attachments, approvals, terminal input, long streaming transcripts, network changes, process death, keyboard/rotation, TalkBack, and signed upgrades on physical devices.

Extend the shared browser tests for desktop and phone when features change. Extend native instrumentation tests when device integration changes.

Use [the Android acceptance checklist](VERIFICATION.md) to track device coverage separately from shared-code coverage.
