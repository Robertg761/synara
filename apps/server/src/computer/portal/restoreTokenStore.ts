/**
 * Persistence for portal restore tokens.
 *
 * `persist_mode: 2` asks the portal to remember a grant across restarts and
 * hands back a `restore_token`. Replaying that token on the next `SelectDevices`
 * is what stops the user being asked to approve remote control every time the
 * server restarts — without it, a crash-restart loop turns into a consent-dialog
 * loop, which trains people to click Allow without reading.
 *
 * A restore token is a credential: anything holding it can re-open remote
 * control of the desktop with no dialog at all. So it is stored with the same
 * private-file handling the rest of the server's secrets get, never logged, and
 * dropped the moment the portal rejects it — a token the portal has revoked is
 * indistinguishable from a token that was never valid, and retrying a dead one
 * costs a user-visible dialog either way.
 */
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

export interface PortalRestoreTokenStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, token: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/**
 * The key a grant is remembered under.
 *
 * A token issued by one portal implementation means nothing to another, and a
 * token issued for a keyboard-only grant will not restore a pointer grant, so
 * both are part of the identity. Restoring the wrong one costs a silent denial
 * that looks like the portal misbehaving.
 */
export function portalRestoreKey(input: {
  readonly desktop: string;
  readonly deviceTypes: number;
  readonly withScreenCast: boolean;
}): string {
  return `${input.desktop}:devices=${input.deviceTypes}:screencast=${input.withScreenCast ? 1 : 0}`;
}

/** For tests and for the case where no state directory can be written. */
export function inMemoryRestoreTokenStore(
  initial: Readonly<Record<string, string>> = {},
): PortalRestoreTokenStore {
  const tokens = new Map(Object.entries(initial));
  return {
    read: (key) => Promise.resolve(tokens.get(key)),
    write: (key, token) => {
      tokens.set(key, token);
      return Promise.resolve();
    },
    clear: (key) => {
      tokens.delete(key);
      return Promise.resolve();
    },
  };
}

export function portalRestoreTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(env.HOME ?? homedir(), ".local", "state");
  return join(stateHome, "synara", "computer", "portal-restore-tokens.json");
}

/**
 * The production store, one small JSON file.
 *
 * Every failure is swallowed into "no remembered grant". A store that throws
 * would turn an unreadable state directory into an unusable desktop backend,
 * when the correct degradation is simply to ask the user again.
 */
export function fileRestoreTokenStore(
  filePath: string = portalRestoreTokenPath(),
): PortalRestoreTokenStore {
  // Serialised so two sessions granting at once cannot lose each other's token
  // to a read-modify-write race on the shared file.
  let queue: Promise<void> = Promise.resolve();
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const load = async (): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  };

  const save = async (tokens: Record<string, string>): Promise<void> => {
    try {
      if (Object.keys(tokens).length === 0) {
        await rm(filePath, { force: true });
        return;
      }
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath,
          contents: `${JSON.stringify(tokens, null, 2)}\n`,
        }),
      );
    } catch {
      // A grant that cannot be remembered still works for this run; the only
      // cost is one more consent dialog next time.
    }
  };

  return {
    read: (key) => serialise(async () => (await load())[key]),
    write: (key, token) =>
      serialise(async () => {
        const tokens = await load();
        if (tokens[key] === token) return;
        tokens[key] = token;
        await save(tokens);
      }),
    clear: (key) =>
      serialise(async () => {
        const tokens = await load();
        if (!(key in tokens)) return;
        delete tokens[key];
        await save(tokens);
      }),
  };
}
