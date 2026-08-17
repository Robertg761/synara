/**
 * The one D-Bus connection Tier 2's portal path owns, behind an interface.
 *
 * Portals are not an ordinary D-Bus API. A portal method does not answer with
 * its result; it answers with the object path of a `Request`, and the result
 * arrives later as a `Response` signal on that path — after the user has
 * clicked something. That means the client has to subscribe *before* it calls,
 * has to survive a signal that arrives before the method reply, and has to be
 * able to `Close` a request that is never going to be answered. None of that is
 * expressible through dbus-next's proxy objects, which want to introspect an
 * object that does not exist until the call is made, so this module drives the
 * low-level message API directly.
 *
 * It is an interface rather than a class for the same reason the desktop helper
 * is: the whole session lifecycle — consent, denial, revocation, version
 * downgrade — has to be testable with no bus, no portal backend, and no user to
 * click a dialog. `fakePortalService.ts` implements this and speaks the same
 * Request/Response convention, so the production brokering code is what the
 * tests exercise.
 *
 * The connection is also the kill switch. A portal session dies with the D-Bus
 * connection it was created on, so dropping this connection stops input at the
 * compositor rather than at a layer that has to be trusted to stop asking.
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";
import type { DbusBus } from "dbus-next";

/**
 * A D-Bus variant, in the shape both dbus-next and `unwrapDbusValue` already
 * use. Callers build plain objects and the bus implementation turns them into
 * whatever its wire library wants, so no module above this one imports dbus-next.
 */
export interface PortalVariant {
  readonly signature: string;
  readonly value: unknown;
}

/** The `a{sv}` options dictionary every portal method takes as its last argument. */
export type PortalOptions = Readonly<Record<string, PortalVariant>>;

export const portalString = (value: string): PortalVariant => ({ signature: "s", value });
export const portalUint32 = (value: number): PortalVariant => ({
  signature: "u",
  value: Math.max(0, Math.floor(value)),
});
export const portalBoolean = (value: boolean): PortalVariant => ({ signature: "b", value });
export const portalStringArray = (value: readonly string[]): PortalVariant => ({
  signature: "as",
  value: [...value],
});

export interface PortalMethodCall {
  readonly destination: string;
  readonly path: string;
  readonly interface: string;
  readonly member: string;
  /** Omitted for a method that takes no arguments. */
  readonly signature?: string;
  readonly body?: readonly unknown[];
}

export interface PortalSignalSpec {
  readonly path: string;
  readonly interface: string;
  readonly member: string;
}

export type PortalSignalListener = (body: readonly unknown[]) => void;

export interface PortalBus {
  /**
   * This connection's unique name. Load-bearing, not diagnostic: the portal
   * derives every `Request` object path from it, and predicting that path is
   * the only way to subscribe before the call that creates it.
   */
  readonly uniqueName: string;
  call(call: PortalMethodCall): Promise<readonly unknown[]>;
  /**
   * Subscribes to a signal. Awaited because on a real bus it installs a match
   * rule, and a call made before the rule is in place can lose its response.
   */
  subscribe(spec: PortalSignalSpec, listener: PortalSignalListener): Promise<() => void>;
  /** The connection died. Every session on it died with it — that is the kill switch. */
  onDisconnected(listener: (reason: Error) => void): () => void;
  close(): Promise<void>;
}

export class PortalBusError extends Error {
  /** The D-Bus error name, when the failure came back as one. */
  readonly errorName: string | undefined;

  constructor(
    message: string,
    options: { readonly errorName?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "PortalBusError";
    this.errorName = options.errorName;
  }
}

/**
 * A fresh `handle_token`.
 *
 * Portals let the caller choose the token their `Request` path is built from,
 * and choosing it is what makes the path predictable enough to subscribe to
 * first. It has to be unique per call — two in-flight requests sharing a token
 * would share an object path and each would resolve on the other's response —
 * and the portal spec restricts it to `[A-Za-z0-9_]`.
 */
export function portalHandleToken(prefix = "synara"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * Where the portal will put the `Request` for a call this connection makes.
 *
 * The rule is in the portal spec: the caller's unique name with the leading
 * colon dropped and every dot turned into an underscore, then the token.
 */
export function portalRequestPath(uniqueName: string, handleToken: string): string {
  return `/org/freedesktop/portal/desktop/request/${portalSenderToken(uniqueName)}/${handleToken}`;
}

/** The same derivation for a `Session` object path, which follows the same rule. */
export function portalSessionPath(uniqueName: string, sessionToken: string): string {
  return `/org/freedesktop/portal/desktop/session/${portalSenderToken(uniqueName)}/${sessionToken}`;
}

function portalSenderToken(uniqueName: string): string {
  return uniqueName.replace(/^:/, "").replaceAll(".", "_");
}

const BUS_CALL_TIMEOUT_MS = 10_000;

/**
 * The production bus: one dbus-next connection with Unix-fd negotiation on.
 *
 * `negotiateUnixFd` is not optional here. `ConnectToEIS`, `OpenPipeWireRemote`,
 * and the clipboard's `SelectionRead` all answer with a file descriptor, and a
 * connection that did not negotiate fd passing gets the number of an fd that
 * was never sent — which reads as a successful call returning a descriptor
 * pointing at something else entirely.
 */
export async function connectSessionPortalBus(
  options: { readonly busAddress?: string } = {},
): Promise<PortalBus> {
  // Keep the optional Linux runtime out of test imports; this resolves only on
  // the production path, after the platform gate.
  const require = createRequire(import.meta.url);
  const dbus = require("dbus-next") as typeof dbusModule;
  const bus = dbus.sessionBus({
    negotiateUnixFd: true,
    ...(options.busAddress ? { busAddress: options.busAddress } : {}),
  });
  const eventBus = bus as unknown as EventEmitter;
  const disconnectListeners = new Set<(reason: Error) => void>();
  let failure: Error | undefined;
  const onFailure = (error: unknown) => {
    failure ??= asError(error);
    for (const listener of disconnectListeners) listener(failure);
  };
  eventBus.on("error", onFailure);
  eventBus.on("disconnect", onFailure);

  try {
    await waitForConnect(bus as unknown as EventEmitter & { name: string | null });
  } catch (error) {
    eventBus.off("error", onFailure);
    eventBus.off("disconnect", onFailure);
    bus.disconnect();
    throw new PortalBusError(
      `The session D-Bus could not be reached (${describe(failure ?? error)}), so no portal session can be opened. ` +
        "Check DBUS_SESSION_BUS_ADDRESS, or start the server from inside the desktop session you want it to drive.",
      { cause: error },
    );
  }

  const uniqueName = (bus as unknown as { name: string }).name;
  const signalListeners = new Map<string, Set<PortalSignalListener>>();
  const onMessage = (message: unknown) => {
    const signal = asSignal(message);
    if (!signal) return;
    const listeners = signalListeners.get(signalKey(signal));
    if (!listeners) return;
    for (const listener of [...listeners]) listener(signal.body);
  };
  eventBus.on("message", onMessage);

  let closed = false;
  return {
    uniqueName,
    call: async (call) => {
      if (failure)
        throw new PortalBusError(`The portal D-Bus connection is gone: ${failure.message}`);
      const message = new dbus.Message({
        destination: call.destination,
        path: call.path,
        interface: call.interface,
        member: call.member,
        ...(call.signature ? { signature: call.signature } : {}),
        body: call.body ? call.body.map((value) => toDbusValue(dbus, value)) : [],
      });
      const reply = await withTimeout(bus.call(message), `${call.interface}.${call.member}`);
      const body = (reply as { readonly body?: readonly unknown[] } | null)?.body;
      return body ?? [];
    },
    subscribe: async (spec, listener) => {
      const key = signalKey(spec);
      const existing = signalListeners.get(key);
      if (existing) {
        existing.add(listener);
      } else {
        signalListeners.set(key, new Set([listener]));
        await addMatch(dbus, bus, matchRule(spec));
      }
      return () => {
        const listeners = signalListeners.get(key);
        if (!listeners) return;
        listeners.delete(listener);
        if (listeners.size > 0) return;
        signalListeners.delete(key);
        // The match rule is left in place deliberately. Removing it is another
        // round trip on a path that runs while a session is being torn down,
        // and an extra rule on a connection that is about to be dropped costs
        // the bus daemon a filter entry and nothing else.
      };
    },
    onDisconnected: (listener) => {
      disconnectListeners.add(listener);
      if (failure) listener(failure);
      return () => disconnectListeners.delete(listener);
    },
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      eventBus.off("message", onMessage);
      eventBus.off("error", onFailure);
      eventBus.off("disconnect", onFailure);
      signalListeners.clear();
      disconnectListeners.clear();
      bus.disconnect();
      return Promise.resolve();
    },
  };
}

function matchRule(spec: PortalSignalSpec): string {
  return `type='signal',interface='${spec.interface}',member='${spec.member}',path='${spec.path}'`;
}

async function addMatch(dbus: typeof dbusModule, bus: DbusBus, rule: string): Promise<void> {
  await withTimeout(
    bus.call(
      new dbus.Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [rule],
      }),
    ),
    "AddMatch",
  );
}

/** dbus-next's marshaller recognises variants by class identity, not by shape. */
function toDbusValue(dbus: typeof dbusModule, value: unknown): unknown {
  if (isPortalVariant(value)) return new dbus.Variant(value.signature, value.value);
  if (Array.isArray(value)) return value.map((entry) => toDbusValue(dbus, entry));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toDbusValue(dbus, entry)]),
    );
  }
  return value;
}

function isPortalVariant(value: unknown): value is PortalVariant {
  return isPlainRecord(value) && typeof value.signature === "string" && "value" in value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DBUS_SIGNAL_TYPE = 4;

function asSignal(message: unknown):
  | {
      readonly path: string;
      readonly interface: string;
      readonly member: string;
      readonly body: readonly unknown[];
    }
  | undefined {
  if (!isPlainRecord(message) || message.type !== DBUS_SIGNAL_TYPE) return undefined;
  const path = message.path;
  const interfaceName = message.interface;
  const member = message.member;
  if (typeof path !== "string" || typeof interfaceName !== "string" || typeof member !== "string") {
    return undefined;
  }
  return {
    path,
    interface: interfaceName,
    member,
    body: Array.isArray(message.body) ? message.body : [],
  };
}

function signalKey(spec: PortalSignalSpec): string {
  return `${spec.path} ${spec.interface} ${spec.member}`;
}

/**
 * dbus-next resolves the connection's unique name asynchronously, and every
 * `Request` path is derived from it, so nothing may be called before it lands.
 */
function waitForConnect(bus: EventEmitter & { name: string | null }): Promise<void> {
  if (bus.name) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle();
      reject(new Error(`the bus did not answer Hello within ${BUS_CALL_TIMEOUT_MS} ms`));
    }, BUS_CALL_TIMEOUT_MS);
    timer.unref?.();
    const settle = () => {
      clearTimeout(timer);
      bus.off("connect", onConnect);
      bus.off("error", onError);
    };
    const onConnect = () => {
      settle();
      resolve();
    };
    const onError = (error: unknown) => {
      settle();
      reject(asError(error));
    };
    bus.once("connect", onConnect);
    bus.once("error", onError);
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PortalBusError(`${label} did not answer within ${BUS_CALL_TIMEOUT_MS} ms.`));
    }, BUS_CALL_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        const name =
          isPlainRecord(error) && typeof error.type === "string" ? error.type : undefined;
        reject(
          new PortalBusError(`${label} failed: ${describe(error)}`, {
            ...(name ? { errorName: name } : {}),
            cause: error,
          }),
        );
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
