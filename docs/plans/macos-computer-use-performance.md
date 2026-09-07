# macOS computer-use performance fixes

The performance audit identified repeated desktop reads, retained screenshot bodies,
input delays, unnecessary accessibility work, idle encoding, queue contention,
thread fan-out, chat invalidation, large tool schemas, and scroll decoding stalls.

The changes address these with cached activity publications and shared desktop
refreshes; diagnostic image omission before serialization; overlapping cursor and
delivery probes; bounded native AX output; raw-pixel still deduplication; concurrent
read-only calls; bounded idle caches and per-client event interests; narrow composer
subscriptions; compact tool results and 1280-pixel observations; and scanline decoding
that yields to I/O and reuses intermediate captures.

Tool definitions measured 39,056 JSON characters after shortening repeated property
prose, versus 48,796 in the audit. Detailed perception screenshots retain the
1536-pixel cap. Submitted text is reported by length instead of echoed back.

## Limits retained deliberately

- Still capture and hashing continue while a visible pane watches. Unchanged frames
  avoid PNG/base64 encoding and transport. Hidden browser tabs detach entirely.
- The default 300 ms observation settle remains. Click confirmation can finish early,
  but an unchanged focus retains its original failure grace before any replay.
- Compatible native text controls use AX insertion. Chromium and explicit physical-key
  mode retain paced events and per-event focus checks.
- Idle thread records are evicted above 256. Owners, in-flight publications, and
  once-surfaced pane records are protected to preserve ownership and auto-open behavior.
  This is a soft bound. Thread snapshots retain window fields for protocol compatibility.
- Native compilation and perception checks can run in the helper matrix. Input delivery,
  permissions, hot-plugging, and multiple Spaces still require the opt-in macOS fixture
  and real-desktop checks described in the native Tests/README.md.

Run `bun run test`, `bun fmt`, `bun lint`, and `bun typecheck` for workspace validation.
Browser regressions cover visibility, availability updates, reconnect seeding, and
transcript rendering. Git integration tests may need test-process overrides for
`diff.mnemonicPrefix` and `pull.rebase`; the terminal fallback test assumes `/bin/bash`.
