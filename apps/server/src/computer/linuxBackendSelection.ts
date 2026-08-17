/**
 * Which computer backend this Linux host gets, decided once at startup.
 *
 * An explicit ordered resolution with **no fallback in any direction**. Falling
 * back from a nested session to the real desktop would hand an agent the human's
 * screen right after an operator asked for an isolated one; falling the other
 * way would hide a broken desktop behind a session nobody can see; and falling
 * from Tier 1 to Tier 2 would silently downgrade a KDE user from a dedicated
 * seat to the shared one without saying so. A tier that fails stays failed, and
 * the backend it produces explains why.
 *
 * The auto-detection asks the session bus who owns `org.kde.KWin` rather than
 * reading `XDG_CURRENT_DESKTOP`. The compositor is the thing that decides
 * whether the KWin plugin can load; the env var is a label a login manager sets
 * and a user can override, and on a KDE session started from a tty it is often
 * simply absent.
 */
import { KWIN_SERVICE } from "./kwinDbus.ts";
import { nestedSessionMode, type NestedSessionMode } from "./nestedKWinSession.ts";

/** Every backend `SYNARA_COMPUTER_BACKEND` can name, in the plan's spelling. */
export const LINUX_BACKEND_CHOICES = ["kwin", "nested", "nested-window", "portal"] as const;
export type LinuxBackendChoice = (typeof LINUX_BACKEND_CHOICES)[number];

export interface LinuxBackendSelection {
  readonly choice: LinuxBackendChoice;
  /**
   * The choice came from `SYNARA_COMPUTER_BACKEND`. A forced choice that then
   * fails must stay failed and say so: an operator who named a backend is
   * debugging that backend, and quietly giving them a different one wastes the
   * next hour of their life.
   */
  readonly forced: boolean;
  /** Why this backend, in one sentence, for the availability card and logs. */
  readonly reason: string;
}

export class InvalidComputerBackendOverrideError extends Error {
  constructor(readonly value: string) {
    super(
      `SYNARA_COMPUTER_BACKEND=${JSON.stringify(value)} is not a backend Synara has. ` +
        `Use one of: ${LINUX_BACKEND_CHOICES.join(", ")}.`,
    );
    this.name = "InvalidComputerBackendOverrideError";
  }
}

/**
 * The override, or `undefined` when none is set.
 *
 * A typo throws instead of being ignored. Every other env var here degrades to
 * a default on bad input, but this one names the backend: silently ignoring
 * `SYNARA_COMPUTER_BACKEND=protal` would boot the wrong tier and look like the
 * override does not work.
 */
export function parseComputerBackendOverride(
  value: string | undefined,
): LinuxBackendChoice | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = LINUX_BACKEND_CHOICES.find((choice) => choice === trimmed.toLowerCase());
  if (!match) throw new InvalidComputerBackendOverrideError(trimmed);
  return match;
}

/** The nested mode a choice implies, or `undefined` for the non-nested tiers. */
export function nestedModeForChoice(choice: LinuxBackendChoice): NestedSessionMode | undefined {
  if (choice === "nested") return "virtual";
  if (choice === "nested-window") return "window";
  return undefined;
}

export interface LinuxBackendSelectionDependencies {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Whether a name is owned on the session bus. Rejects when the bus itself is
   * unreachable, which the caller distinguishes from an unowned name.
   */
  readonly busNameHasOwner: (name: string) => Promise<boolean>;
}

/**
 * Resolves the backend in the plan's order: override, nested opt-in, KWin
 * presence, Tier 2.
 */
export async function selectLinuxBackend(
  dependencies: LinuxBackendSelectionDependencies,
): Promise<LinuxBackendSelection> {
  const env = dependencies.env ?? process.env;

  const override = parseComputerBackendOverride(env.SYNARA_COMPUTER_BACKEND);
  if (override) {
    return {
      choice: override,
      forced: true,
      reason: `SYNARA_COMPUTER_BACKEND=${override} selected this backend explicitly, so no other backend is tried.`,
    };
  }

  const nested = nestedSessionMode(env);
  if (nested) {
    return {
      choice: nested === "window" ? "nested-window" : "nested",
      forced: false,
      reason: `SYNARA_COMPUTER_NESTED=${env.SYNARA_COMPUTER_NESTED} asked for a private compositor this process owns.`,
    };
  }

  try {
    if (await dependencies.busNameHasOwner(KWIN_SERVICE)) {
      return {
        choice: "kwin",
        forced: false,
        reason: `${KWIN_SERVICE} is owned on the session bus, so this is a KWin session and Tier 1 applies.`,
      };
    }
  } catch (error) {
    // An unreachable session bus is not evidence that KWin is absent — it is
    // evidence that nothing here can work. Keeping the KWin path means its
    // availability check reports the bus failure in its own words, which is
    // both the pre-existing behavior on such a host and the more actionable
    // message; routing to Tier 2 would blame the wrong tier for a dead bus.
    return {
      choice: "kwin",
      forced: false,
      reason: `The session bus could not be asked who owns ${KWIN_SERVICE} (${error instanceof Error ? error.message : String(error)}), so the KWin backend reports the failure directly.`,
    };
  }

  return {
    choice: "portal",
    forced: false,
    reason: `No process owns ${KWIN_SERVICE}, so this is not a KWin session and Tier 2 applies.`,
  };
}
