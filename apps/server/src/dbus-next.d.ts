declare module "dbus-next" {
  interface DbusBus {
    getProxyObject(service: string, path: string): Promise<DbusProxyObject>;
    on(event: "error" | "disconnect", listener: (...args: readonly unknown[]) => void): void;
    off?(event: "error" | "disconnect", listener: (...args: readonly unknown[]) => void): void;
    disconnect(): void;
  }

  interface DbusProxyObject {
    getInterface(name: string): unknown;
  }

  export function sessionBus(options?: Record<string, unknown>): DbusBus;

  const dbus: { readonly sessionBus: typeof sessionBus };
  export default dbus;
}
