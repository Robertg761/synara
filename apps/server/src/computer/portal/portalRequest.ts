/**
 * The portal Request/Response calling convention.
 *
 * Every interactive portal method returns an object path instead of an answer.
 * The real answer arrives later as `org.freedesktop.portal.Request.Response`,
 * carrying a response code — 0 success, 1 the user cancelled, 2 the portal
 * ended it some other way — and a results dictionary. Three things about that
 * make it worth its own module rather than being inlined at each call site:
 *
 *   - The subscription has to exist before the call. The portal is free to emit
 *     `Response` before the method reply reaches us, and a client that waits for
 *     the reply first can lose the only copy of its answer.
 *   - The path has to be predicted, not read from the reply, for the same
 *     reason. `handle_token` exists so that it can be.
 *   - A request that is never answered has to be closable. `Start` waits on a
 *     human, so "never answered" is a normal outcome — the dialog can sit there
 *     until the session it belongs to is gone.
 *
 * The response is deliberately not turned into a thrown error for codes 1 and 2.
 * A cancelled consent dialog is not a failure of the call; it is an answer, and
 * the consent state machine needs to tell it apart from a bus error.
 */
import {
  type PortalBus,
  type PortalOptions,
  PortalBusError,
  portalHandleToken,
  portalRequestPath,
  portalString,
} from "./portalBus.ts";
import { PORTAL_BUS_NAME, PORTAL_OBJECT_PATH } from "./probe.ts";

// Re-exported so the session and the fake portal address the bus through this
// module rather than reaching into the probe for two string constants.
export { PORTAL_BUS_NAME, PORTAL_OBJECT_PATH };

export const PORTAL_REQUEST_INTERFACE = "org.freedesktop.portal.Request";
export const PORTAL_SESSION_INTERFACE = "org.freedesktop.portal.Session";

/** Portal response codes, from the Request interface. */
export const PORTAL_RESPONSE_SUCCESS = 0;
export const PORTAL_RESPONSE_CANCELLED = 1;
export const PORTAL_RESPONSE_ENDED = 2;

export interface PortalResponse {
  readonly code: number;
  readonly results: Readonly<Record<string, unknown>>;
}

export interface PortalRequestCall {
  /** The interface the method lives on, e.g. `org.freedesktop.portal.RemoteDesktop`. */
  readonly interface: string;
  readonly member: string;
  /** Arguments before the trailing options dictionary. `a{sv}` is appended here. */
  readonly signature?: string;
  readonly body?: readonly unknown[];
  readonly options?: PortalOptions;
  /**
   * How long to wait for the `Response` signal. `Start` gets no timeout by
   * default because it is blocked on a human reading a dialog, and killing that
   * dialog out from under them would be worse than waiting.
   */
  readonly timeoutMs?: number;
}

/**
 * Makes a portal request and resolves with the response the user's answer
 * produced. Rejects only when the bus itself failed or the wait timed out.
 */
export async function callPortalRequest(
  bus: PortalBus,
  call: PortalRequestCall,
): Promise<PortalResponse> {
  const token = portalHandleToken();
  const requestPath = portalRequestPath(bus.uniqueName, token);

  let settle: ((response: PortalResponse) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  // Captured rather than awaited: the signal can beat the method reply, and the
  // value has to survive until the reply has been checked for an error.
  let early: PortalResponse | undefined;
  const answered = new Promise<PortalResponse>((resolve, reject) => {
    settle = (response) => resolve(response);
    fail = reject;
  });
  // `answered` is rejected from callbacks, not from the await below, and two of
  // those callbacks can fire before anything is waiting on it: `onDisconnected`
  // calls back synchronously on a bus that is already dead, and `bus.call` then
  // throws on the same failure, so the `return await answered` that would have
  // observed the rejection is never reached. An unobserved rejection is a
  // process-level `unhandledRejection`, which is the whole server going down
  // because a desktop bus dropped. The handler makes the rejection observed
  // exactly once here; every real consumer still awaits `answered` itself.
  answered.catch(() => undefined);

  const unsubscribe = await bus.subscribe(
    { path: requestPath, interface: PORTAL_REQUEST_INTERFACE, member: "Response" },
    (body) => {
      const response = parseResponse(body);
      early = response;
      settle?.(response);
    },
  );

  const disposeDisconnect = bus.onDisconnected((reason) => {
    fail?.(
      new PortalBusError(
        `The portal D-Bus connection dropped while waiting for ${call.interface}.${call.member}: ${reason.message}`,
        { cause: reason },
      ),
    );
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const options: PortalOptions = { ...call.options, handle_token: portalString(token) };
    const signature = `${call.signature ?? ""}a{sv}`;
    const reply = await bus.call({
      destination: PORTAL_BUS_NAME,
      path: PORTAL_OBJECT_PATH,
      interface: call.interface,
      member: call.member,
      signature,
      body: [...(call.body ?? []), options],
    });

    // The portal may hand back a path other than the predicted one only when it
    // ignored our token, which no released portal does; if it ever happens the
    // response would arrive somewhere nothing is listening, so it is worth
    // failing loudly rather than hanging until the timeout.
    const returnedPath = reply[0];
    if (typeof returnedPath === "string" && returnedPath !== requestPath && early === undefined) {
      throw new PortalBusError(
        `The desktop portal put ${call.interface}.${call.member} at ${returnedPath} instead of the requested ${requestPath}, ` +
          "so its answer cannot be received. This portal implementation does not honour handle_token.",
      );
    }

    if (early) return early;

    if (call.timeoutMs !== undefined) {
      const timeoutMs = call.timeoutMs;
      timer = setTimeout(() => {
        fail?.(
          new PortalBusError(
            `The desktop portal did not answer ${call.interface}.${call.member} within ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    }

    return await answered;
  } catch (error) {
    // Leaving an unanswered Request behind leaks a portal-side object and, for
    // Start, a dialog the user can still click on with nothing listening.
    void closePortalRequest(bus, requestPath);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    settle = undefined;
    fail = undefined;
    disposeDisconnect();
    unsubscribe();
  }
}

/** Best-effort: the request may already be gone, which is not worth reporting. */
export async function closePortalRequest(bus: PortalBus, requestPath: string): Promise<void> {
  try {
    await bus.call({
      destination: PORTAL_BUS_NAME,
      path: requestPath,
      interface: PORTAL_REQUEST_INTERFACE,
      member: "Close",
    });
  } catch {
    // Intentionally ignored.
  }
}

function parseResponse(body: readonly unknown[]): PortalResponse {
  const code = typeof body[0] === "number" ? body[0] : PORTAL_RESPONSE_ENDED;
  const results = body[1];
  return {
    code,
    results:
      typeof results === "object" && results !== null ? (results as Record<string, unknown>) : {},
  };
}

/**
 * Reads a `D-Bus properties` value off the portal object.
 *
 * Portal versions and `AvailableDeviceTypes` are plain properties, not requests,
 * and they are the only honest way to know whether clipboard support or a given
 * device type exists before asking the user to approve something that cannot work.
 */
export async function readPortalProperty(
  bus: PortalBus,
  interfaceName: string,
  property: string,
): Promise<unknown> {
  const reply = await bus.call({
    destination: PORTAL_BUS_NAME,
    path: PORTAL_OBJECT_PATH,
    interface: "org.freedesktop.DBus.Properties",
    member: "Get",
    signature: "ss",
    body: [interfaceName, property],
  });
  return unwrapVariant(reply[0]);
}

/** Portal results arrive as variants; every consumer wants the value inside. */
export function unwrapVariant(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "signature" in value &&
    "value" in value &&
    typeof (value as { signature: unknown }).signature === "string"
  ) {
    return unwrapVariant((value as { value: unknown }).value);
  }
  return value;
}

export function variantNumber(value: unknown): number | undefined {
  const unwrapped = unwrapVariant(value);
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return unwrapped;
  if (typeof unwrapped === "bigint") return Number(unwrapped);
  return undefined;
}

export function variantString(value: unknown): string | undefined {
  const unwrapped = unwrapVariant(value);
  return typeof unwrapped === "string" ? unwrapped : undefined;
}

export function variantBoolean(value: unknown): boolean | undefined {
  const unwrapped = unwrapVariant(value);
  return typeof unwrapped === "boolean" ? unwrapped : undefined;
}
