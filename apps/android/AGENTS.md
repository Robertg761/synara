# Android shell

The desktop renderer in apps/web is the feature source of truth. Android packages that renderer through Capacitor.

- Put feature UI, state, validation, RPCs, and streaming behavior in the shared renderer or existing shared packages. Do not introduce a Kotlin implementation of a desktop feature.
- Kotlin is for Android capabilities that cannot live in the renderer. Keep its public interface in packages/contracts/src/mobileBridge.ts and adapt it in apps/web/src/shellBridge.ts.
- Keep layout, pointer type, and native capabilities independent. Phone layout also applies to narrow desktop windows.
- Never load a remote website into the privileged shell or add server.url, allowNavigation, mixed content, or SSL-error bypasses to the production configuration.
- Use the checked-in Gradle wrapper and Java 21. Run bun run --cwd apps/android prepare:android before native builds.
- Do not commit copied web assets, generated Capacitor Gradle files, credentials, keystores, or SDK paths.
- Changes to shared UI require phone-layout verification. Changes to the native bridge require device instrumentation tests as well as shared adapter tests.
- Do not claim background delivery while the WebView is suspended. That requires a separately verified server-push implementation.
