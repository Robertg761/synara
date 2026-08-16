import { useEffect } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { useComputerStateStore } from "../computerStateStore";

export function useComputerEventBridge(): void {
  useEffect(() => {
    const api = ensureNativeApi();
    if (!api.computer) {
      return;
    }
    const unsubscribe = api.computer.onEvent((event) => {
      const store = useComputerStateStore.getState();
      switch (event.type) {
        case "computer.thread-state":
          store.upsertThreadState(event.state);
          break;
        case "computer.windows-changed":
          store.applyWindowsChanged(event.windows);
          break;
        case "computer.action":
          store.recordAction(event);
          break;
        case "computer.frame":
          break;
      }
    });
    return unsubscribe;
  }, []);
}
