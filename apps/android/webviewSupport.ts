// Keep native startup checks aligned with the bundled JavaScript and Tailwind 4 CSS.
// Tailwind 4 requires Chrome 111: https://tailwindcss.com/docs/compatibility
export const MIN_ANDROID_WEBVIEW_VERSION = 111;
export const ANDROID_WEB_BUILD_TARGET = `chrome${MIN_ANDROID_WEBVIEW_VERSION}`;
