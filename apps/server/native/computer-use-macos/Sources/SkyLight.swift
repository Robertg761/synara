// Private WindowServer (SkyLight) entry points, resolved at runtime.
//
// Everything here is SPI: nothing is linked, every symbol is looked up once
// with `dlsym`, and every caller has a public-API fallback for the case where a
// symbol is gone on this macOS. That is the posture the helper already takes for
// `CGEventSetWindowLocation` (moved here from Input.swift), and it is what turns
// an OS release that renames a symbol into a reported capability gap rather than
// a dyld crash at launch. `report()` says which entry points resolved so the
// backend and `--probe` can show it.
//
// The one non-obvious routine is `activateWithoutRaise`. AppKit only routes
// keyboard events, and hit-tests mouse events against live tracking state, in
// an application it believes is *active*; WindowServer only makes an app active
// by bringing its windows forward and (on a multi-Space setup) switching Spaces,
// which is exactly the disruption this helper exists to avoid. The two can be
// split: posting a pair of process-level event records — a "deactivate" to the
// app that is currently front, an "activate" to the target — flips the target's
// AppKit-active state while WindowServer's z-order and Space stay untouched.
// This is yabai's `window_manager_focus_window_without_raise` recipe and the
// mechanism the open-source cua-driver validated against its toolkit matrix;
// it is also what Codex's `SyntheticAppFocusEnforcer` amounts to (see
// docs/computer-use-macos-reference.md §2.3). The gesture layer undoes it
// afterwards so the human's app is left as it was found.

import AppKit
import CoreGraphics
import Foundation

/// Eight bytes, two `UInt32`s: the layout `ProcessSerialNumber` has always had.
struct ProcessSerial: Equatable {
  var high: UInt32 = 0
  var low: UInt32 = 0
}

enum SkyLight {
  typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
  private typealias GetFrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
  private typealias MainConnectionID = @convention(c) () -> UInt32
  private typealias GetWindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias GetConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
  private typealias SetFrontProcessWithOptions = @convention(c) (UnsafeRawPointer, UInt32, UInt32) -> Int32
  private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
  private typealias GetProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32

  /// `kCPSNoWindows`: make the process front without ordering all of its
  /// windows forward — only the named one.
  private static let setFrontNoWindows: UInt32 = 0x400

  private struct Symbols {
    let setWindowLocation: SetWindowLocation?
    let postEventRecordTo: PostEventRecordTo?
    let getFrontProcess: GetFrontProcess?
    let mainConnectionID: MainConnectionID?
    let getWindowOwner: GetWindowOwner?
    let getConnectionPSN: GetConnectionPSN?
    let setFrontProcessWithOptions: SetFrontProcessWithOptions?
    let getProcessForPID: GetProcessForPID?
    let getProcessPID: GetProcessPID?
  }

  private static let symbols: Symbols = {
    let skylight = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    if skylight == nil { logDiagnostic("SkyLight.framework did not load; focus SPI unavailable") }
    func resolve<T>(_ name: String, _ type: T.Type) -> T? {
      var pointer = skylight.flatMap { dlsym($0, name) }
      if pointer == nil { pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) }
      guard let pointer else {
        logDiagnostic("private symbol \(name) is missing on this macOS")
        return nil
      }
      return unsafeBitCast(pointer, to: type)
    }
    return Symbols(
      setWindowLocation: resolve("CGEventSetWindowLocation", SetWindowLocation.self),
      postEventRecordTo: resolve("SLPSPostEventRecordTo", PostEventRecordTo.self),
      getFrontProcess: resolve("_SLPSGetFrontProcess", GetFrontProcess.self),
      mainConnectionID: resolve("CGSMainConnectionID", MainConnectionID.self),
      getWindowOwner: resolve("SLSGetWindowOwner", GetWindowOwner.self),
      getConnectionPSN: resolve("SLSGetConnectionPSN", GetConnectionPSN.self),
      setFrontProcessWithOptions: resolve(
        "SLPSSetFrontProcessWithOptions", SetFrontProcessWithOptions.self),
      // Public but deprecated Process Manager calls; resolved the same way so the
      // deprecation does not become a build warning and their absence is handled.
      getProcessForPID: resolve("GetProcessForPID", GetProcessForPID.self),
      getProcessPID: resolve("GetProcessPID", GetProcessPID.self))
  }()

  /// Stamps a window-local point on an event; nil when the symbol is gone.
  static var setWindowLocation: SetWindowLocation? { symbols.setWindowLocation }

  /// Which entry points resolved on this OS, for `capabilities` and `--probe`.
  static func report() -> [String: Bool] {
    [
      "setWindowLocation": symbols.setWindowLocation != nil,
      "focusWithoutRaise": symbols.postEventRecordTo != nil && symbols.getFrontProcess != nil
        && (symbols.getConnectionPSN != nil || symbols.getProcessForPID != nil),
      "setFrontProcess": symbols.setFrontProcessWithOptions != nil,
    ]
  }

  static var focusWithoutRaiseAvailable: Bool { report()["focusWithoutRaise"] == true }

  // MARK: - Processes

  /// The pid WindowServer considers front right now. Unlike
  /// `NSWorkspace.frontmostApplication` this does not depend on our own run loop
  /// having processed an activation notification, so it is current immediately
  /// after a change we caused.
  static func frontmostPID() -> pid_t? {
    if let psn = frontProcess(), let pid = pid(for: psn) { return pid }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  private static func frontProcess() -> ProcessSerial? {
    guard let getFront = symbols.getFrontProcess else { return nil }
    var psn = ProcessSerial()
    let status = withUnsafeMutablePointer(to: &psn) { getFront(UnsafeMutableRawPointer($0)) }
    return status == 0 ? psn : nil
  }

  private static func pid(for psn: ProcessSerial) -> pid_t? {
    guard let getPID = symbols.getProcessPID else { return nil }
    var serial = psn
    var pid: pid_t = 0
    let status = withUnsafePointer(to: &serial) { getPID(UnsafeRawPointer($0), &pid) }
    return status == 0 && pid > 0 ? pid : nil
  }

  /// The serial of the process owning `windowID`: through WindowServer's own
  /// connection table first, then the Process Manager by pid.
  private static func process(owning windowID: CGWindowID, pid: pid_t) -> ProcessSerial? {
    if let connectionID = symbols.mainConnectionID, let getOwner = symbols.getWindowOwner,
      let getPSN = symbols.getConnectionPSN
    {
      var owner: UInt32 = 0
      if getOwner(connectionID(), windowID, &owner) == 0, owner != 0 {
        var psn = ProcessSerial()
        let status = withUnsafeMutablePointer(to: &psn) { getPSN(owner, UnsafeMutableRawPointer($0)) }
        if status == 0 { return psn }
      }
    }
    guard let getForPID = symbols.getProcessForPID else { return nil }
    var psn = ProcessSerial()
    let status = withUnsafeMutablePointer(to: &psn) { getForPID(pid, UnsafeMutableRawPointer($0)) }
    return status == 0 ? psn : nil
  }

  // MARK: - Focus

  /// The outcome of a focus prelude.
  ///
  /// `activated` and `needsRestore` are deliberately separate. The pair is two
  /// posts to two different processes, and the failure that matters is the one
  /// in between: if the deactivate landed and the activate did not — the target
  /// quit, its window died — the human's app is left holding an unmatched
  /// deactivate. Collapsing both into one boolean meant the caller skipped the
  /// restore in exactly the case that needed it most.
  struct FocusOutcome {
    /// The target's app now believes it is active.
    let activated: Bool
    /// A deactivate was posted to the human's app and is owed a matching restore.
    let needsRestore: Bool
  }

  /// Whether the focus record pair is even available for this target.
  ///
  /// A cheap precondition check that posts nothing: without the SPI, or without
  /// a resolvable process serial for the target, the pair cannot be sent and a
  /// background gesture will be hit-tested as background. Callers use it to
  /// decide the delivery rung before building any event.
  static func canActivateWithoutRaise(pid: pid_t, windowID: CGWindowID) -> Bool {
    guard focusWithoutRaiseAvailable, frontProcess() != nil,
      process(owning: windowID, pid: pid) != nil
    else { return false }
    return true
  }

  /// Make `pid` believe it is the active application, addressed at `windowID`,
  /// without raising anything or switching Spaces. The caller proceeds whatever
  /// this returns, since the pid-targeted post that follows is what actually
  /// delivers the event — but it must honour `needsRestore`.
  static func activateWithoutRaise(
    pid: pid_t, windowID: CGWindowID, previousWindowID: CGWindowID
  ) -> FocusOutcome {
    guard let previous = frontProcess(), let target = process(owning: windowID, pid: pid),
      previous != target
    else { return FocusOutcome(activated: false, needsRestore: false) }
    // The window id in a record names the window the *receiving* process is
    // being told about, so the deactivate carries the human app's own window,
    // not the target's. yabai's `window_manager_focus_window_without_raise`
    // does the same, and the asymmetry is why `restoreActivation` passes 0.
    let deactivated = post(record(kind: .deactivate, windowID: previousWindowID), to: previous)
    if !deactivated {
      logDiagnostic("focus prelude: deactivate record was refused by the front process")
      return FocusOutcome(activated: false, needsRestore: false)
    }
    // The recipe this implements sleeps between the two posts; without it the
    // activate can overtake the resign-active the deactivate started.
    usleep(40_000)
    let activated = post(record(kind: .activate, windowID: windowID), to: target)
    if !activated {
      logDiagnostic("focus prelude: activate record was refused by the target process")
    }
    return FocusOutcome(activated: activated, needsRestore: true)
  }

  /// The inverse of `activateWithoutRaise`: hand AppKit-active state back to
  /// the app that had it. `windowID` is a window of the app being restored (0
  /// when none is known).
  static func restoreActivation(to previousPID: pid_t, windowID: CGWindowID, from targetPID: pid_t)
    -> Bool
  {
    guard let previous = process(owning: windowID, pid: previousPID),
      let target = process(owning: 0, pid: targetPID), previous != target
    else { return false }
    let deactivated = post(record(kind: .deactivate, windowID: 0), to: target)
    let activated = post(record(kind: .activate, windowID: windowID), to: previous)
    return deactivated && activated
  }

  /// The explicit foreground rung: genuinely make `pid` the front process, with
  /// only `windowID` ordered forward. This *does* move the human's active app —
  /// callers restore the previous one when the gesture is done.
  static func setFrontProcess(pid: pid_t, windowID: CGWindowID) -> Bool {
    guard let setFront = symbols.setFrontProcessWithOptions,
      var target = process(owning: windowID, pid: pid)
    else {
      return NSRunningApplication(processIdentifier: pid)?.activate(options: []) ?? false
    }
    let status = withUnsafePointer(to: &target) {
      setFront(UnsafeRawPointer($0), windowID, setFrontNoWindows)
    }
    return status == 0
  }

  private enum RecordKind: UInt8 {
    case activate = 0x01
    case deactivate = 0x02
  }

  /// The 248-byte process-level event record: size at 0x04, kind 0x0D at 0x08,
  /// the window id little-endian at 0x3C, and the activate/deactivate marker at
  /// 0x8A. Every other byte is zero.
  private static func record(kind: RecordKind, windowID: CGWindowID) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: 0xF8)
    bytes[0x04] = 0xF8
    bytes[0x08] = 0x0D
    bytes[0x3C] = UInt8(windowID & 0xFF)
    bytes[0x3D] = UInt8((windowID >> 8) & 0xFF)
    bytes[0x3E] = UInt8((windowID >> 16) & 0xFF)
    bytes[0x3F] = UInt8((windowID >> 24) & 0xFF)
    bytes[0x8A] = kind.rawValue
    return bytes
  }

  private static func post(_ record: [UInt8], to psn: ProcessSerial) -> Bool {
    guard let post = symbols.postEventRecordTo else { return false }
    var serial = psn
    return record.withUnsafeBufferPointer { bytes in
      withUnsafePointer(to: &serial) { post(UnsafeRawPointer($0), bytes.baseAddress!) }
    } == 0
  }
}
