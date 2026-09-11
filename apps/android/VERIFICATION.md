# Android acceptance checks

Android uses the shared desktop renderer. That gives both apps the same feature code, but device integration still needs separate verification.

## Test environments

- Shared browser tests cover desktop and phone layouts with protocol fixtures.
- Native instrumentation runs on a dedicated API 36 emulator. It must never use a personal device because the storage tests clear saved pairing.
- Paired visual review uses isolated HTTPS fixture and real Synara servers, with a test CA installed only in the disposable emulator. The production app keeps normal certificate verification. Fixture conversations cannot validate real provider execution.
- Physical-device and signed-release checks remain separate from emulator checks.

## Coverage to retain

| Area | Acceptance checks |
| --- | --- |
| Packaging | Debug and release builds, release shrinking, bundled assets, real WebView startup |
| Pairing | HTTPS exchange, rejected credentials, secure persistence, relaunch, revoked sessions |
| Existing installations | Previous encrypted session format, damaged storage, same-key signed upgrade |
| Incoming links | Cold and warm launch, one-time consumption, renderer reload, activity recreation, stale-event race |
| Navigation | Home, chat, settings, Back through menus/dialogs/history, root backgrounding |
| Layout | Portrait and landscape, keyboard resize, scrolling, touch targets, safe insets, large text |
| Transcript | Markdown/code, long history, live output, reconnect, partial streams |
| Composer | Text input, model selection, attachments, send/cancel, approvals and user-input requests |
| Files | Authenticated upload/download, plan exports, native share sheet, failure handling |
| Notifications | Permission changes, delivery, thread/server tap routing, suspended-app limitations |
| Browser | Reachable pages, navigation, lifecycle, capture, clear capability differences |
| Terminal | Open, type, resize, output, reconnect, keyboard behavior |
| Release | Signing, upgrade, physical-device checks, TalkBack, background/process-death behavior |

Record observed results separately from source review. A passing build or a fixture screenshot does not establish completion of every row.

## Observed results, September 10, 2026

- API 36 emulator paired to an isolated real Synara server over HTTPS/WSS, created a project in a disposable directory, and received a real Codex response to a no-tools prompt.
- A second real provider workflow submitted from the Android composer created `android-review.txt` in that disposable project with exactly `ANDROID_FILE_EDIT_VERIFIED` and a trailing newline. The phone Review action opened the shared diff showing the single added line. This run used medium reasoning and full access, so it does not establish approval-prompt coverage.
- Native instrumentation verified encrypted storage compatibility, incoming-link consumption across recreation, guest browser isolation and navigation, visible viewport capture, notification delivery, and shared-file bytes and access boundaries.
- API 26 with stock WebView 69 displayed the script-free update screen instead of failing silently. The shared transport also has a regression test for supported WebViews that lack `AbortSignal.any`.
- Debug and unsigned release APKs built successfully with release shrinking. Native unit tests and Android lint passed.
- The integrated shared checks passed 336 focused unit tests and 51 browser checks across phone navigation, touch controls, settings, onboarding, browser entry, terminal rendering, downloads, notifications, transport behavior, and theme selection. One browser assertion was updated to the current notification message and passed on rerun.
- Browser capture through the shared menu produced a readable 1080-by-1435 page image in the composer. Native touch navigation and Android Back worked within the guest history.
- Appearance settings switched the installed APK between light and dark themes with matching native bar backgrounds and readable icons in portrait and landscape. Native backgrounds come from the shared theme color, and a device regression covers configuration changes.

The phone terminal uses xterm's DOM renderer. The emulator exposed a blank WebGL canvas despite a valid context; forcing the existing fallback restored real server output. A regression test now verifies visible terminal text through hide/show with the native mobile renderer.

Phone pane tests exercise the actual router and store, including restored desktop state, explicit content-open actions, rapid taps, Back, and older panel deep links. Dialog tests mount the onboarding flow at short landscape, short portrait, and desktop sizes, and verify that footer actions remain reachable.

The installed APK passed browser button and legacy-link open/close checks, native browser rotation, terminal input/output, settings category navigation, and landscape onboarding footer interaction. The final combined native suite passed all 12 tests on the APK with the theme background fix, and all seven native JVM tests passed. An earlier rotation attempt crashed the host emulator's rendering thread; restarting the same test device with ANGLE software graphics and Vulkan disabled allowed the rotation checks to pass.

The provider checks cover a message round trip and a file edit with diff review. Approvals, reconnect during a long response, and the remaining acceptance rows still need their own observed results.

Version 0.2.1 addresses the physical-phone report of header controls overlapping the status bar. The native container now owns system-bar, cutout, and keyboard insets; Capacitor's WebView-version-dependent CSS inset handling is disabled. Embedded browser bounds use that same protected viewport. Debug and unsigned release builds, seven JVM tests, Android lint, and all 13 native instrumentation tests passed. The new regression checks inset ownership after viewport-cover detection, cutout and keyboard transitions, consumed child insets, and guest position. The first browser capture check ran before painting; the test now explicitly waits for WebView visual state and the complete suite passed. Portrait and keyboard screenshots were inspected on API 36 with WebView 133. A physical-phone retest and execution on WebView 140+ remain unverified. The workspace Bun formatting, lint, and typecheck commands were not run because authorization is still pending.

## Version 0.2.2 responsive follow-up

The installed 0.2.1 APK reproduced the reported home control overlap at 393 CSS pixels: the branch picker extended 99 pixels beyond the viewport and covered Temporary. The shared phone tray now uses separate project and workspace rows, constrains branch text, and reserves a full touch target for Temporary. The welcome heading scrolls within the space above the composer on short screens.

Six focused ChatView browser cases passed, covering 320, 390, 412, 732-by-364, and 1280 pixel viewports, actual branch/Temporary clicks, heading containment, and project reset across desktop/phone resizing. The resize test now reacquires DOM references after the phone shell remounts.

The broader audit found overlapping expanded touch targets in native browser and terminal toolbars. Browser controls now have separate rows and 44-pixel targets; long tabs retain their width and scroll. Terminal workspace/sidebar actions also have separate 44-pixel cells. Nine browser and tab touch cases, eight terminal touch cases, 17 header/settings/project-dialog audit cases, and related desktop regressions passed. Android CI includes the new cases and an explicit coarse-pointer run.

This audit does not establish every environment/file/diff workflow, populated terminal group, sidebar/project interaction, or physical-device accessibility behavior. The previously documented release gaps remain.

The combined 0.2.2 Android renderer build, debug APK, and unsigned release APK passed. Seven JVM tests and Android lint passed. All 13 native instrumentation tests passed on the dedicated API 36 emulator. The debug APK retains the installed test build's signing certificate and increments versionCode to 4.

Installed-app checks verified separate 44-pixel branch/Temporary controls with a 6-pixel gap at 393 CSS pixels, actual taps on both controls, and bounded landscape heading scrolling. The first browser check exposed that the phone uses the sidebar host rather than the sheet host used by the initial fixture. The final renderer enables native touch chrome in both, and all eight sidebar/sheet viewport cases pass. After rebuilding, the installed browser displayed two rows of 44-pixel controls; native taps created and closed a tab, and the HTTPS guest aligned below the toolbar and above the bottom system inset. The 13-test native suite ran before this final renderer-only host correction. A live terminal session was not exercised by this mock fixture; terminal touch geometry was covered by the browser tests.

Published debug APK SHA-256: `7883ee720c3dd6880955adbb419191686abfe0bdfe2e90cc9db030e9566e345c`.

## Known release gaps

- Reliable notifications while Android suspends or stops the app need server push.
- Android browser annotations and remote agent control still need platform adapters.
- Further provider failure/reconnect and approval workflows, signed upgrades, and physical-device accessibility testing must pass before production certification.

Run focused checks during fixes. Follow the repository rules for the final workspace verification pass.
