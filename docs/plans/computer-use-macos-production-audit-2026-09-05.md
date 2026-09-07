# macOS computer use: production readiness audit

Audited branch: `claude/computer-use-macos-s1vpp0`, commit `2f518942c`.

**Verdict: not ready for production.** The helper has substantial hardening, but the complete tool → manager → helper → observation loop still has failures that can send input to the wrong window or continue acting after Stop. These take priority over cursor animation and visual polish.

This is an audit, not an implementation pass. Product code was not changed. Nine temporary regression tests reproduced eight findings below; their source is preserved in [the evidence file](audit-evidence/computer-use-macos-2026-09-05.repro.ts.txt). It deliberately has a `.txt` suffix so the unresolved assertions do not enter the normal test suite.

## Evidence and limits

| Verification                                                                         | Result                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Computer server suites, gateway computer tools, session lease, harness policy        | 728 passed, 13 skipped                                          |
| Provider adapters, Codex manager, gateway transport and session registry             | 511 passed, 2 skipped                                           |
| Focused web computer suites, including component rendering and setup hooks           | 103 passed                                                      |
| Signing/packaging configuration, probe assertion, shared computer code and contracts | 45 passed                                                       |
| Compile the current Swift helper                                                     | Passed                                                          |
| Real helper capability probe                                                         | Passed: macOS 27.0.0, arm64, four SkyLight capabilities present |
| Real helper perception integration                                                   | 6 passed                                                        |
| New reproductions asserting the desired production behavior                          | 9 failed, as detailed below                                     |

Total existing tests passed: **1,393**, with 15 skipped. A second targeted web run confirmed the four component/hook files were included; those 25 tests are already counted above.

The live checks exercised capture, enumeration, accessibility description, and transport. They did **not** inject mouse or keyboard input into the user's applications. Input findings below distinguish deterministic tests with doubles from native-code analysis. This audit did not verify a newly signed/notarized installation, real model API round trips, another macOS version, Intel hardware, or multiple physical displays.

The workspace's `AGENTS.md` prohibits running `bun fmt`, `bun lint`, and `bun typecheck` without an explicit request. Those checks were not run, and this report does not constitute release sign-off.

## Release blockers

### R1 · P1 · Stop does not cancel work already inside a computer tool

**Reproduced.** Pause a click while its semantic target is being read, abort the tool's Effect, then let the read finish: the backend still receives the click. The gateway interrupts the waiting fiber, but `computerTools.handle` ignores the AbortSignal provided by `Effect.tryPromise`. Its underlying promise continues through targeting and injection. Neither manager actions nor native input loops accept cancellation. Releasing the desktop lease on a terminal event does not stop that work.

Locations: `apps/server/src/agentGateway/computerTools.ts:908`; `apps/server/src/computer/ComputerManager.ts:939`; `apps/server/src/computer/Layers/ComputerLeaseReactor.ts:35`; `apps/server/src/computer/macComputerHelperClient.ts:118`.

Fix: propagate cancellation and the original turn identity through the whole operation; recheck before injection and between multi-step operations. Add a native cancellation/unwind path for active drags and typing. Reject waiting operations and do not hand the desktop to another task until the old action has stopped. Linux PR #822 provides queued-operation cancellation and deferred lease release, but does not by itself provide prompt cancellation inside a running native gesture.

Acceptance: stopping during target lookup causes no later input; stopping mid-drag releases the button promptly; stopping during text input prevents subsequent characters; a new owner cannot overlap residual work.

### R2 · P1 · Concurrent calls interleave target selection and input

**Reproduced.** Two keyboard calls in one task name different windows. The first selects Calculator, the second selects another window, and the first text is delivered with the second window still selected. The desktop lease excludes other tasks; it does not serialize calls within its owner. The Swift input queue serializes individual RPCs, so `focus A → focus B → type A` remains possible. Post-action screenshots and screenshot registration can interleave too.

Locations: `apps/server/src/computer/ComputerManager.ts:1408`; `apps/server/src/computer/ComputerManager.ts:1519`; `apps/server/src/computer/ComputerManager.ts:1553`; `apps/server/native/computer-use-macos/Sources/Dispatch.swift:68`.

Fix: port the bounded whole-operation queue from current Linux PR #822. The transaction must include target resolution, preparation, input, observation, and frame registration, and cover pane input as well as model tools. Recheck turn authority when dequeuing. Prefer atomic helper requests carrying `windowId` for keyboard actions instead of a mutable target-setting RPC followed by input.

Acceptance: parallel calls targeting separate windows cannot cross-deliver; observations belong to their own actions; overflow produces a bounded, actionable refusal.

### R3 · P1 · Screenshot deduplication can preserve the wrong coordinate frame

**Reproduced in two tests.** First, move a window without changing its pixels: `observeCapture` compares only task/window identity and image hash, suppressing the new geometry. Second, get an action screenshot of Calculator, explicitly capture another window, then act on Calculator again: the manager reports `screenshotUnchanged`, although the gateway's newest screenshot is now the other window. The model is told to reuse an image while default coordinates resolve through a different or stale frame.

Locations: `apps/server/src/computer/ComputerManager.ts:797`; `apps/server/src/agentGateway/computerTools.ts:823`; `apps/server/src/agentGateway/computerTools.ts:1025`; `apps/server/src/computer/screenshotFrames.ts:107`.

Fix: move deduplication into the same per-task registry that records **every delivered screenshot**. Reuse only when pixels, window, dimensions, origin, extent, and scale all match the latest delivery. Return the reused screenshot ID and metadata explicitly. Current Linux PR #822 already implements this design.

Acceptance: moved windows emit new geometry even with identical pixels; an intervening explicit screenshot invalidates unrelated reuse; subsequent clicks map through the actual delivered frame.

### R4 · P1 · Semantic activation drops its resolved window

**Reproduced.** `MacComputerBackend.performAction(target, "click" | "activate")` calls `this.click(target.point)` without `target.node.windowId`. The helper then picks the topmost window at that point, even when semantic resolution selected an obscured control in another window. The result is subsequently labeled with the requested window, concealing the mismatch. The unaddressable-node fallback in `setValue` drops the window in the same way and inserts text rather than guaranteeing replacement.

Locations: `apps/server/src/computer/MacComputerBackend.ts:1196`; `apps/server/src/computer/MacComputerBackend.ts:1177`; `apps/server/native/computer-use-macos/Sources/Input.swift:1110`.

Fix: retain the resolved window on every fallback, prefer the addressed AX action when appropriate, and refuse when replacement semantics cannot be provided. Never report a requested window as though it were an observed delivery target.

Acceptance: semantic click/set-value against a covered window cannot affect its occluder; the output identifies the actual target.

### R5 · P1 · Keyboard observations follow the human's focus

**Reproduced with the helper's real response shape.** The agent aims window 5, types without repeating `window_id`, and the returned screenshot captures window 7, the human's frontmost app. `Windows.dictionary` reports human focus; keyboard RPCs return no target ID; the manager interprets `focused` as agent focus when selecting the action observation. Restoring the human's foreground app therefore makes the common background typing loop look at the wrong app.

Locations: `apps/server/native/computer-use-macos/Sources/main.swift:95`; `apps/server/native/computer-use-macos/Sources/Windows.swift:254`; `apps/server/src/computer/MacComputerBackend.ts:1129`; `apps/server/src/computer/ComputerManager.ts:854`.

Fix: distinguish human-active and agent-targeted windows. Return the resolved window ID from native keyboard/scroll actions and use it for observation. Do not infer agent focus from WindowServer's frontmost app.

Acceptance: after a background click followed by unqualified typing or a hotkey, the observation still shows the agent's target while the human keeps their foreground window.

### R6 · P1 · Keyboard aim survives a change of task owner

**Reproduced.** Task A aims Calculator and finishes. Task B, which never aimed a window, calls `type_text` and writes into A's target. Lease release clears the lease and cursor label but not native `keyboardTarget`; macOS does not implement a clear-target operation. Idle lease takeover has the same issue.

Locations: `apps/server/src/computer/ComputerManager.ts:1626`; `apps/server/src/computer/ComputerManager.ts:1572`; `apps/server/native/computer-use-macos/Sources/Input.swift:158`; `apps/server/src/computer/MacComputerBackend.ts:1235`.

Fix: clear input targeting and pending gesture state on ownership changes, turn/session end, and helper restart; or bind target state to an explicit owner/turn token. Clear it after the previous operation drains, together with the cancellation fix.

Acceptance: an unaimed task cannot inherit another task's typing destination, even when both use the same model/provider.

### R7 · P1 · Hover still changes keyboard aim through the manager

**Reproduced.** A window-scoped `move_cursor` calls `prepareResolvedTarget`, which sends `focus-window`; that native handler sets `keyboardTarget`. Removing `aim()` from the Swift `move` implementation fixed only the lower layer. Hover is now advertised and approved as a non-mutating operation, yet it still changes where later unqualified keys go. Semantic hover also supplies a resolved window and follows this path.

Locations: `apps/server/src/computer/ComputerManager.ts:1033`; `apps/server/src/computer/ComputerManager.ts:1879`; `apps/server/native/computer-use-macos/Sources/main.swift:286`; `apps/server/src/agentGateway/computerTools.ts:88`.

Fix: give movement/hover preparation semantics separate from keyboard aiming. Test the public gateway through manager/backend behavior, not only the Swift method in isolation.

Acceptance: a hover over B preserves the agent's existing keyboard target A; a hover with no prior target does not authorize unqualified typing.

### R8 · P1 · Foreground fallback can type into a human-selected app mid-action

**Native-code finding; not injected on the live desktop.** `withForeground` checks the frontmost PID once, then runs an entire text/chord body through the session event tap. If the human switches apps while it runs, subsequent events follow the human's new foreground app. Text can be long: the admitted 16,384 characters cost approximately 98 seconds at the foreground loop's 6 ms per character before other overhead, although the current 15-second timeout cuts it short. Automatic fallback also means a nominally background action can bring an app forward without the caller selecting that mode.

Locations: `apps/server/native/computer-use-macos/Sources/Input.swift:1085`; `apps/server/native/computer-use-macos/Sources/Input.swift:586`; `apps/server/native/computer-use-macos/Sources/Input.swift:325`; `apps/server/native/computer-use-macos/Sources/Input.swift:1532`.

Fix: make the background-only guarantee an enforceable delivery policy. If foreground fallback is supported, expose its status and policy explicitly, detect human interruption, and stop before sending further global input. At minimum revalidate the destination throughout the sequence and avoid restoring an old foreground app over a newer deliberate human choice. A check followed by global posting still has a race; PID/window-targeted delivery is the stronger guarantee.

Acceptance: switching apps during a long fallback operation never sends text/shortcuts into the new human app. Test with an owned fixture and event log.

### R9 · P2 · Valid long actions exceed the transport deadline

**Reproduced with simulated time and the real transport.** A valid 30-second drag hits `helper_timeout` at 15 seconds. The backend classifies that as a broken connection and disposes the helper during the gesture. Foreground typing longer than roughly 2,500 characters can hit the same deadline. Queued input RPCs spend their timeout waiting too.

Locations: `apps/server/src/computer/macComputerHelperClient.ts:83`; `packages/contracts/src/computer.ts:99`; `apps/server/native/computer-use-macos/Sources/Input.swift:360`; `apps/server/src/computer/MacComputerBackend.ts:1753`.

Fix: align admitted action duration with transport budgets, account for preparation/restoration, and distinguish a requested long action from a wedged helper. Use cancellable, bounded chunks for long text. Do not solve this only by globally increasing timeouts.

Acceptance: the advertised maximum drag completes; long text either completes or is rejected before partial input; cancellation remains prompt.

## Capability and polish gaps

### R10 · P1 for the stated scope · Pi and Antigravity cannot perform computer actions

**Confirmed in code and existing tests.** The gateway unconditionally refuses approval-required computer tools for these providers, including full-access sessions. They receive the catalog and the harness instruction to use it, but clicking/typing return `ComputerApprovalRequired`. This is an intentional refusal added by the earlier audit, not a newly introduced bypass; it nevertheless prevents the requested “any vision model in Synara” outcome.

Locations: `apps/server/src/agentGateway/approvalGate.ts:30`; `apps/server/src/agentGateway/computerTools.ts:910`; `apps/server/src/agentGateway/Layers/AgentGatewaySessionRegistry.ts:28`.

Fix: implement a Synara-owned computer action gate with consistent runtime-mode semantics, or add the missing provider approval integration. Until then, advertise the limited capability honestly. Keep the refusal in place until that integration exists. Add provider/model qualification covering image tool-result delivery, tool invocation, denial, cancellation, and resume; vision input alone does not prove the full loop works.

### R11 · P2 · Moving the visible cursor does not produce a real hover

**Confirmed in native code.** The tool description promises tooltips and hover-opened menus, but Swift `move` only calls `cursor.glide`; it posts no mouse-moved event to the target application. Moving an independent overlay cannot trigger an app's hover handlers.

Locations: `apps/server/src/agentGateway/computerTools.ts:1406`; `apps/server/native/computer-use-macos/Sources/Input.swift:226`.

Fix: implement window-addressed hover delivery without changing keyboard aim, or remove the unsupported promise until implemented. Test an owned AppKit tracking area and a browser `mouseenter` handler with the real system pointer elsewhere.

### R12 · P2 · Native menus and transient surfaces lack a complete targeting path

**Confirmed structural gap; exact toolkit behavior needs fixture testing.** `Windows.enumerate` drops every nonzero window layer. Pointer hit-testing uses that list. Accessibility description starts at each application window rather than including application-level menu bars. Thus a screenshot can show a menu bar, status menu, or elevated popup that is absent from both targeting sources; an unscoped click can resolve the ordinary window underneath, and a window-scoped point outside its bounds is refused. Some app-local dropdowns will work; this is not a claim that every menu fails.

Locations: `apps/server/native/computer-use-macos/Sources/Windows.swift:218`; `apps/server/native/computer-use-macos/Sources/Windows.swift:355`; `apps/server/native/computer-use-macos/Sources/Accessibility.swift:104`; `apps/server/src/computer/ComputerManager.ts:1847`.

Fix: represent supported transient surfaces and application menus explicitly, retain their owner, and target their AX actions or actual popup window. Test native menus, context menus, save/open panels, and browser select controls.

### R13 · P2 · Window-scoped state still walks every application's accessibility tree

**Confirmed in code.** `computer_get_state(window_id)` filters the result after an unscoped desktop read. The Swift helper already accepts `windowIds`, but the backend calls `describe-ui` without them. Its 6,000-node desktop budget is shared in window order, so a target behind several large trees can be omitted before filtering. Naming that window cannot recover it. Unrelated slow AX applications can also consume the 15-second transport budget and restart an otherwise working helper.

Locations: `apps/server/src/agentGateway/computerTools.ts:1200`; `apps/server/src/computer/MacComputerBackend.ts:927`; `apps/server/native/computer-use-macos/Sources/main.swift:127`; `apps/server/native/computer-use-macos/Sources/Accessibility.swift:94`.

Fix: pass window scope through manager/backend into `describe-ui`; add a wall-time budget as well as node limits and preserve truncation/source-failure metadata. Use the same scope for semantic target resolution.

Acceptance: a small requested window remains discoverable beside a very large or unresponsive unrelated app.

### R14 · P2 · Multi-display fallback loses Synara-window exclusion

**Confirmed path difference; multiple displays not exercised here.** Single-display ScreenCaptureKit capture excludes Synara's own windows. A region spanning two displays deliberately falls back to `screencapture -R`, which has no equivalent exclusion. The whole-workspace Computer pane can therefore photograph itself again on that path, defeating the previous mirror/deduplication fix. The documented claim that every display capture excludes Synara is too broad.

Locations: `apps/server/native/computer-use-macos/Sources/Capture.swift:227`; `apps/server/native/computer-use-macos/Sources/Capture.swift:251`; `apps/server/native/computer-use-macos/Sources/Capture.swift:78`.

Fix: composite per-display SCK captures with consistent exclusions and coordinate metadata, or explicitly handle host-window masking in the fallback. Verify negative origins, mixed display scale, display removal, and a pane visible on either monitor.

## Native Codex parity decisions

[Official Computer Use documentation](https://developers.openai.com/codex/app/computer-use) describes background macOS use, per-app approval and remembered app access, settings to revoke access, and opt-in locked use. Synara currently has desktop-wide provider tool authority and OS grants rather than app-scoped grants. Locked use is absent. Those are additional product gaps if “exactly like native Codex” includes its permission model and locked-machine behavior; neither should be implied by the current feature's availability.

Synara can keep its ordinary MCP tool interface. [OpenAI's computer-use guidance](https://developers.openai.com/api/docs/guides/tools-computer-use) supports custom UI tools and code-execution harnesses; copying Codex's REPL names is not required to deliver comparable behavior. The relevant standard is successful, observable workflows with the same targeting, interruption, and background-use guarantees.

Further UX work after the blockers:

- Keep a desktop-level Stop control available for the entire ownership period, including model thinking gaps and when another task is selected. Currently `agentActive` means calls in flight, with a 1.5-second UI delay; the specific Stop button disappears between slower calls. The snapshot supplies only `controlledByOtherThread`, not the owner needed to stop or open that task. See `ComputerManager.ts:2193` and `ComputerPanel.logic.ts:363`.
- Distinguish background delivery, foreground fallback, paused-for-human-input, unavailable target, and permission setup in the UI. The current generic activity badge cannot explain those states.
- Show which app/window is being operated, and make delivery warnings available consistently. Avoid claiming an action was verified merely because input was posted.
- Keep the Beta label until the behavioral and release matrix below passes; removing it is the last polish step.

## Reuse the Linux work

The local `origin/computer-use-linux-3-core` ref was stale. I fetched the actual GitHub PR heads for this comparison without switching or merging branches.

- [PR #822: computer-control core](https://github.com/Emanuele-web04/synara/pull/822), audited head `0a2d4be2b`: adds `DesktopOperationQueue`, whole-operation transactions, queued cancellation/turn-authority checks, deferred lease release, and unified screenshot-frame reuse. These directly address much of R1–R3. Adapt those changes to the newer macOS observation/setup behavior; replacing the file wholesale would lose branch-specific fixes.
- [PR #821: approvals and lifecycle](https://github.com/Emanuele-web04/synara/pull/821), head `ff4404db5`: useful for consistent provider lifecycle/capability integration. Its approval infrastructure does not automatically remove the explicit Pi/Antigravity refusal.
- The stack links in those PRs identify #820 shared plumbing, #823 KWin, #824 nested KWin, and #780 Hyprland. The shared-core fixes are the highest-value reuse for this audit.

## Recommended completion order

1. Port and adapt the Linux operation queue, authority checks, deferred release, and screenshot registry. Add native cancellation so Stop reaches active input.
2. Repair target identity end to end: atomic window-addressed keyboard operations, truthful result window IDs, task-scoped aim, semantic fallbacks, and hover preparation.
3. Fix action time budgets and human interruption during foreground fallback. Establish an enforceable background-use policy.
4. Complete the missing provider gate and qualify the same desktop workflow across supported vision/tool-capable providers. Make unsupported combinations explicit.
5. Finish actual hover, native menus, scoped AX reads, and multi-display capture. Then polish persistent ownership/Stop/status UI.
6. Validate installed release artifacts and run the explicitly requested workspace checks before release sign-off.

Required release evidence: owned-fixture tests that assert actual received events and unchanged human pointer/focus; at least two materially different model/provider transports; covered and multi-window AppKit/Chromium apps; real hover/menu/drag/Unicode input; cancellation at every stage; permission denial/revocation/regrant; helper crash/restart; lock/unlock; multiple Spaces and mixed-scale displays; and TCC persistence after an installed signed build is updated. The weekly/manual helper matrix is a useful symbol tripwire, but its perception-only tests and current single-machine evidence do not establish these behaviors.

## Reproduction files

The preserved test source uses the existing fake backend plus a simulated macOS transport. Copy it to `apps/server/src/computer/productionAudit.repro.test.ts` and run `bun run --cwd apps/server test src/computer/productionAudit.repro.test.ts` to reproduce against the audited commit. Nine desired-behavior assertions fail; none sends real input. The concurrency reproduction intentionally schedules the currently unprotected interleaving; convert it to a queue-aware regression test when implementing serialization.

The source was removed from the normal test directory after the audit. The report and evidence are the only repository additions; the pre-existing untracked `.agents/` directory was left alone.
