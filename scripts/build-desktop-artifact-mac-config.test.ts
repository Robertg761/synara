import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_APPSNAP_HELPER_NAME,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_COMPUTER_HELPER_ASAR_EXCLUSION,
  MAC_COMPUTER_HELPER_BUNDLE_PATH,
  MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH,
  MAC_COMPUTER_HELPER_STAGE_PATH,
  MAC_DEVICE_HELPER_RESOURCE_PATH,
  MAC_DEVICE_HELPER_STAGE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MICROPHONE_USAGE_DESCRIPTION,
  MAC_HELPER_X64_ARCH_FILES,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  SCREEN_RECORDING_USAGE_DESCRIPTION,
  validateDesktopNativeBuildHost,
  WINDOWS_INSTALLER_GUID,
} from "./lib/desktop-platform-build-config.ts";
import {
  COMPUTER_HELPER_BUNDLE_NAME,
  COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH,
} from "@synara/shared/computerHelperPaths";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

describe("createDesktopPlatformBuildConfig", () => {
  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const dmg = config.dmg as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.notarize, true);
    assert.equal(dmg.sign, true);
    assert.equal(dmg.writeUpdateInfo, false);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(MAC_APPSNAP_HELPER_BUNDLE_PATH, "Contents/Helpers/synara-appsnap-helper");
    // The packaged helper path is the shared constant the desktop main process
    // resolves at runtime, not a second spelling of it: a bundle rename that
    // only reached one of them is exactly the failure this pins.
    assert.equal(
      MAC_COMPUTER_HELPER_BUNDLE_PATH,
      `Contents/Helpers/${COMPUTER_HELPER_BUNDLE_NAME}`,
    );
    assert.equal(
      MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH,
      COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH,
    );
    assert.deepStrictEqual(mac.binaries, [
      MAC_APPSNAP_HELPER_BUNDLE_PATH,
      MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH,
    ]);
    // @electron/universal takes one glob; both helper paths must survive into it.
    assert.equal(mac.x64ArchFiles, MAC_HELPER_X64_ARCH_FILES);
    assert.ok(MAC_HELPER_X64_ARCH_FILES.includes(MAC_APPSNAP_HELPER_NAME));
    assert.ok(
      MAC_HELPER_X64_ARCH_FILES.includes(
        MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH.slice("Contents/Helpers/".length),
      ),
    );
    assert.equal(
      MAC_APPSNAP_HELPER_STAGE_PATH,
      "apps/desktop/native/appsnap/build/synara-appsnap-helper",
    );
    assert.equal(MAC_APPSNAP_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/appsnap/build/**");
    assert.equal(MAC_COMPUTER_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/computer-use/build/**");
    assert.equal(
      MAC_COMPUTER_HELPER_STAGE_PATH,
      `apps/desktop/native/computer-use/build/${COMPUTER_HELPER_BUNDLE_NAME}`,
    );
    assert.deepStrictEqual(config.files, [
      "**/*",
      MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
      MAC_COMPUTER_HELPER_ASAR_EXCLUSION,
    ]);
    assert.deepStrictEqual(config.extraFiles, [
      {
        from: "apps/desktop/native/appsnap/build/synara-appsnap-helper",
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
    ]);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSScreenCaptureUsageDescription, SCREEN_RECORDING_USAGE_DESCRIPTION);
  });

  it("leaves the DMG container unsigned for build-only macOS artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: false,
    });

    assert.deepStrictEqual(config.dmg, { sign: false, writeUpdateInfo: false });
  });

  it("leaves non-macOS platform configs unchanged", () => {
    const linux = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
    });
    const win = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
      windowsAzureSignOptions: { publisherName: "Synara" },
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.extraFiles, undefined);
    assert.deepStrictEqual(linux.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(linux.linux, {
      target: ["AppImage"],
      executableName: "synara",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "synara",
        },
      },
    });

    assert.equal(win.mac, undefined);
    assert.equal(win.extraFiles, undefined);
    assert.deepStrictEqual(win.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(WINDOWS_INSTALLER_GUID, "368107a8-afe6-5db5-ab3b-d4f331684868");
    assert.deepStrictEqual(win.nsis, {
      guid: WINDOWS_INSTALLER_GUID,
    });
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      publisherName: "Synara",
      azureSignOptions: { publisherName: "Synara" },
    });
  });

  it("omits Azure signing options for unsigned build-only artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
    });

    assert.deepStrictEqual(config.win, {
      target: ["nsis"],
      icon: "icon.ico",
    });
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
    });

    assert.deepStrictEqual([...NODE_PTY_ASAR_UNPACK_GLOBS], ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.asarUnpack, [...NODE_PTY_ASAR_UNPACK_GLOBS]);
  });

  it("blocks unsupported or non-matching Linux native build hosts", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      null,
    );

    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "universal",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      "Linux desktop artifacts support x64 or arm64 builds, not universal builds.",
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    assert.ok(issue?.includes("Build linux/x64 on a matching Linux host"));
  });

  it("requires a macOS host for the native Swift AppSnap helper", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "mac",
        arch: "universal",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      null,
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "mac",
      arch: "arm64",
      hostPlatform: "linux",
      hostArch: "arm64",
    });
    assert.ok(issue?.includes("Build mac/arm64 on macOS"));
  });

  it("keeps separate macOS sources for solid and rounded icons", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "assets/prod/black-macos-1024.png");
    assert.equal(
      BRAND_ASSET_PATHS.productionMacLegacyIconPng,
      "assets/prod/black-macos-legacy-1024.png",
    );
  });
});
