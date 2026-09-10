# Android acceptance checks

Android uses the shared desktop renderer. That gives both apps the same feature code, but device integration still needs separate verification.

## Test environments

- Shared browser tests cover desktop and phone layouts with protocol fixtures.
- Native instrumentation runs on a dedicated API 36 emulator. It must never use a personal device because the storage tests clear saved pairing.
- Paired visual review uses an isolated HTTPS fixture server and a test CA installed only in the disposable emulator. The production app keeps normal certificate verification. Fixture conversations cannot validate real provider execution.
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

## Known release gaps

- Reliable notifications while Android suspends or stops the app need server push.
- Android browser annotations and remote agent control still need platform adapters.
- Real provider workflows, signed upgrades, and physical-device accessibility testing must pass before production certification.

Run focused checks during fixes. Follow the repository rules for the final workspace verification pass.
