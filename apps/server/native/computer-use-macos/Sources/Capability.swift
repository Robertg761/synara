// Capability and permission probe.
//
// Two consumers: the one-shot `--probe` (read by the build and the settings
// checklist) and the live `capabilities` RPC the backend reads to seed
// `health.captureAvailable` and to decide availability. Both report the same
// facts — arch, macOS version, and which TCC grants are present — from inside
// the helper, which is the only place a responsible-process misattribution
// shows up honestly.

import ApplicationServices
import CoreGraphics
import Foundation

enum Capability {
  /** Ask macOS on an explicit user action; TCC remains the authority. */
  static func requestPermissions() -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() {
      _ = CGRequestScreenCaptureAccess()
    }
    if !AXIsProcessTrusted() {
      let options = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
      ] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(options)
    }
    return report()
  }

  static func report() -> [String: Any] {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return [
      "arch": machineArch(),
      "macosVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
      // CGPreflight does not prompt; it reports the current grant. A missing
      // grant is reported, never demanded, so the backend can surface a card.
      "screenRecording": CGPreflightScreenCaptureAccess(),
      "accessibility": AXIsProcessTrusted(),
      // Which private WindowServer entry points resolved on this OS: the
      // background focus prelude and window-local stamping depend on them.
      "skylight": SkyLight.report(),
      "protocolVersion": 1,
    ]
  }

  private static func machineArch() -> String {
    var info = utsname()
    uname(&info)
    let machine = withUnsafePointer(to: &info.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
    return machine
  }
}
