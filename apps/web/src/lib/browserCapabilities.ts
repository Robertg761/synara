import { isElectron } from "../env";
import { readNativeApi } from "../nativeApi";

/** Local preview support, independent of the viewport and remote server platform. */
export function hasEmbeddedBrowser(): boolean {
  return readNativeApi()?.browser?.capabilities?.embeddedPreview ?? isElectron;
}
