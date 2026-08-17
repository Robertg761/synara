declare module "dbus-next" {
  export interface DbusBus {
    getProxyObject(service: string, path: string): Promise<DbusProxyObject>;
    /**
     * Send a message and wait for its reply.
     *
     * The portal client needs this rather than the proxy API: the portal's
     * Request/Response convention requires subscribing to a signal on a path
     * predicted before the call, because the Response can arrive ahead of the
     * method reply, and a proxy cannot express that ordering.
     */
    call(message: Message): Promise<Message | null>;
    on(event: "error" | "disconnect", listener: (...args: readonly unknown[]) => void): void;
    off?(event: "error" | "disconnect", listener: (...args: readonly unknown[]) => void): void;
    disconnect(): void;
  }

  interface DbusProxyObject {
    getInterface(name: string): unknown;
  }

  export function sessionBus(options?: Record<string, unknown>): DbusBus;

  // `Message` and `Variant` come from the package's own types.d.ts, which this
  // declaration merges with; they are named here so the default import carries
  // them, since that file declares no default export.
  const dbus: {
    readonly sessionBus: typeof sessionBus;
    readonly Message: typeof Message;
    readonly Variant: typeof Variant;
  };
  export default dbus;
}
