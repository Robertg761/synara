// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

import computerHelperBundle from "@synara/shared/computerHelperBundle" with { type: "json" };
import {
  COMPUTER_HELPER_BUNDLE_NAME,
  COMPUTER_HELPER_PACKAGED_BUNDLE_PATH,
  COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH,
} from "@synara/shared/computerHelperPaths";

export const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";
/**
 * Shared with the helper bundle's own Info.plist, which the build script writes
 * from the same JSON. macOS shows whichever plist belongs to the process that
 * asks, so the two must not drift into telling the user different things.
 */
export const SCREEN_RECORDING_USAGE_DESCRIPTION =
  computerHelperBundle.screenRecordingUsageDescription;
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
/** Where a packaged `Synara.app` keeps its native helpers. */
export const MAC_HELPERS_BUNDLE_DIR = "Contents/Helpers";
export const MAC_APPSNAP_HELPER_NAME = "synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = `${MAC_HELPERS_BUNDLE_DIR}/${MAC_APPSNAP_HELPER_NAME}`;
export const MAC_COMPUTER_HELPER_STAGE_DIR = "apps/desktop/native/computer-use/build";
export const MAC_COMPUTER_HELPER_STAGE_PATH = `${MAC_COMPUTER_HELPER_STAGE_DIR}/${COMPUTER_HELPER_BUNDLE_NAME}`;
export const MAC_COMPUTER_HELPER_ASAR_EXCLUSION = `!${MAC_COMPUTER_HELPER_STAGE_DIR}/**`;
export const MAC_COMPUTER_HELPER_BUNDLE_PATH = COMPUTER_HELPER_PACKAGED_BUNDLE_PATH;
export const MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH = COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH;
/**
 * The one `x64ArchFiles` pattern for both Swift helpers. @electron/universal
 * takes a single glob, so the two paths are brace-expanded into it; both halves
 * are relative to `Contents/Helpers`, which is why the shared prefix is lifted
 * out rather than repeated.
 */
export const MAC_HELPER_X64_ARCH_FILES = [
  `${MAC_HELPERS_BUNDLE_DIR}/{`,
  [MAC_APPSNAP_HELPER_BUNDLE_PATH, MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH]
    .map((bundlePath) => bundlePath.slice(`${MAC_HELPERS_BUNDLE_DIR}/`.length))
    .join(","),
  "}",
].join("");

export const MAC_DEVICE_HELPER_STAGE_PATH = "apps/server/dist/device-helper";
export const MAC_DEVICE_HELPER_RESOURCE_PATH = "Resources/device-helper";
export const WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;

export interface DesktopPlatformBuildConfig {
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly signed?: boolean;
  readonly windowsAzureSignOptions?: Record<string, string>;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include native Swift AppSnap and computer-use helpers.",
      `Build mac/${input.arch} on macOS so the helpers can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const nativePackaging = { asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS] };

  if (input.platform === "mac") {
    const mac = {
      target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
      icon: MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      hardenedRuntime: input.signed === true,
      notarize: input.signed === true,
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH, MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH],
      // The universal build stages the same pre-lipo'd helpers in both app trees.
      // @electron/universal needs this pattern to preserve those existing fat
      // binaries. Composed from the same constants the paths above use so a
      // bundle rename cannot leave the glob pointing at the old name.
      x64ArchFiles: MAC_HELPER_X64_ARCH_FILES,
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
        NSScreenCaptureUsageDescription: SCREEN_RECORDING_USAGE_DESCRIPTION,
      },
    } satisfies Record<string, unknown>;

    return {
      ...nativePackaging,
      dmg: {
        sign: input.signed === true,
        // The signed release flow notarizes and staples the DMG after electron-builder exits.
        // Do not emit a blockmap/update entry whose hashes would describe the pre-stapled image;
        // macOS auto-updates use the separately finalized ZIP artifact.
        writeUpdateInfo: false,
      },
      files: ["**/*", MAC_APPSNAP_HELPER_ASAR_EXCLUSION, MAC_COMPUTER_HELPER_ASAR_EXCLUSION],
      extraFiles: [
        {
          from: MAC_APPSNAP_HELPER_STAGE_PATH,
          to: "Helpers/synara-appsnap-helper",
        },
        {
          from: MAC_COMPUTER_HELPER_STAGE_PATH,
          to: `Helpers/${COMPUTER_HELPER_BUNDLE_NAME}`,
        },
        {
          from: MAC_DEVICE_HELPER_STAGE_PATH,
          to: MAC_DEVICE_HELPER_RESOURCE_PATH,
        },
      ],
      mac,
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      linux: {
        target: [input.target],
        executableName: "synara",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "synara",
          },
        },
      },
    };
  }

  return {
    ...nativePackaging,
    // Keep the Windows product registration stable while the public app ID changes.
    // This lets NSIS updates replace the existing installation and own its uninstaller.
    nsis: {
      guid: WINDOWS_INSTALLER_GUID,
    },
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions
        ? {
            publisherName: input.windowsAzureSignOptions.publisherName,
            azureSignOptions: input.windowsAzureSignOptions,
          }
        : {}),
    },
  };
}
