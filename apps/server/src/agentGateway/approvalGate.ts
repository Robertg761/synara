/**
 * Which provider sessions can put a human in the loop before a tool runs.
 *
 * Every family that guards a physical or exfiltrating effect — the device tools,
 * the computer tools — refuses those calls outright for a session Synara cannot
 * interrupt. The set of such providers was declared twice, once per family, and
 * a provider added to one list and not the other was a silent bypass: `pi`
 * re-exposes every gateway tool as a native custom tool whose `execute` posts
 * `tools/call` directly, with no permission hook and no `request/respond`
 * support, and it was in neither list — so `computer_click` and `computer_type_text`
 * ran on the user's real desktop with nobody asked.
 *
 * One set, one place, both families.
 *
 * @module agentGateway/approvalGate
 */
import type { ProviderKind } from "@synara/contracts";

/**
 * Providers whose sessions run without a per-tool approval gate.
 *
 * - `antigravity` runs with `--dangerously-skip-permissions`.
 * - `pi` exposes gateway tools as native custom tools and supports neither a
 *   permission hook nor the MCP `request`/`respond` elicitation round trip, so
 *   nothing between the model and the effect can ask.
 *
 * A provider belongs here when Synara has no way to show the user the call
 * before it happens — not when the user has merely chosen to auto-approve.
 */
export const PROVIDERS_WITHOUT_APPROVAL_GATE: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  "antigravity",
  "pi",
]);

/** Whether this session can ask the user before a guarded tool runs. */
export function providerHasApprovalGate(provider: ProviderKind): boolean {
  return !PROVIDERS_WITHOUT_APPROVAL_GATE.has(provider);
}
