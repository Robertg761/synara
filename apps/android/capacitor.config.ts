import type { CapacitorConfig } from "@capacitor/cli";
import { MIN_ANDROID_WEBVIEW_VERSION } from "./webviewSupport";
import {
  SYNARA_MOBILE_APP_ID,
  SYNARA_MOBILE_APP_HOSTNAME,
} from "../../packages/shared/src/mobileIdentity";

const config: CapacitorConfig = {
  appId: SYNARA_MOBILE_APP_ID,
  appName: "Synara",
  webDir: "build/web",
  android: {
    path: ".",
    backgroundColor: "#101012",
    minWebViewVersion: MIN_ANDROID_WEBVIEW_VERSION,
    // Insets belong to the native container; phone layout handles the keyboard.
    adjustMarginsForEdgeToEdge: "force",
  },
  server: {
    hostname: SYNARA_MOBILE_APP_HOSTNAME,
    androidScheme: "https",
    errorPath: "webview-error.html",
  },
  plugins: {
    LocalNotifications: { smallIcon: "ic_notification" },
  },
};
export default config;
