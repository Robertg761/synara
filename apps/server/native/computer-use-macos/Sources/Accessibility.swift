// Accessibility perception and semantic actuation.
//
// AX is the macOS analog of AT-SPI on the Linux side: the structure source the
// agent reads to decide what to do, and the path for a few semantic writes
// (`set-value`, `perform-action`) where a physical click is the wrong tool.
// Physical clicks/typing/scrolling still go through synthetic input — the
// reference's "prefer simulating physical clicks over Accessibility actions" —
// so this file is only structure plus the two semantic writes.
//
// Every AX element reports its frame in global top-left points already, so a
// node's coordinates flow straight to the pointer path with no conversion. The
// node path is the child-index route from the window root, which lets the Node
// backend re-address a control on a fresh read without holding a live handle.
//
// The walk is bounded on every axis, because AX is synchronous IPC into other
// processes and a single unresponsive app would otherwise stall the agent's
// whole perception step (reference §4.3):
//
//   * `AXUIElementSetMessagingTimeout` — 1 s per application, 0.35 s per window.
//   * One IPC per node: role, title, description, value, position, size, and
//     children come back from a single `AXUIElementCopyMultipleAttributeValues`
//     instead of seven round trips.
//   * `AXUIElementIsAttributeSettable` — the extra IPC that answers "is this
//     editable" — only for roles that can plausibly hold a value.
//   * 2048 nodes per window (the AT-SPI helper's limit) marked in band with
//     `"truncated": true` on the window node, and ~6000 for the whole desktop.
//   * Subtrees whose frame lies entirely outside their window are skipped
//     (off-screen scroll content), while zero-size containers are still
//     descended — a layout wrapper with no frame routinely holds real controls.
//   * Skipped children keep their sibling index, so `nodePath` stays the real
//     child-index route and `set-value`/`perform-action` re-resolve correctly.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum Accessibility {
  /// Per-window and whole-desktop node caps. The window cap matches the Linux
  /// AT-SPI helper so both platforms truncate a runaway tree at the same size.
  private static let maxNodesPerWindow = 2048
  private static let maxNodesPerDesktop = 6000
  private static let applicationMessagingTimeout: Float = 1.0
  private static let windowMessagingTimeout: Float = 0.35

  /// Attributes fetched for every node in one IPC, in this order.
  private static let nodeAttributes =
    [
      kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
      kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
    ] as CFArray

  /// Roles whose value is worth an `AXUIElementIsAttributeSettable` round trip.
  /// Asking every group and static text doubles the IPC count of a walk to learn
  /// "no" each time.
  private static let valueBearingRoles: Set<String> = [
    kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, kAXSliderRole, kAXIncrementorRole,
    kAXCheckBoxRole, kAXRadioButtonRole, kAXPopUpButtonRole, kAXMenuItemRole,
    "AXSearchField", "AXSecureTextField", "AXStepper",
  ]

  /// Whether this process is a trusted Accessibility client right now.
  static func isTrusted() -> Bool {
    AXIsProcessTrusted()
  }

  /// The desktop AX forest: one child per on-screen window, already in global
  /// coordinates. `windowIds`, when given, restricts the walk to those windows —
  /// the cheap read when the agent is working inside one app.
  static func describeDesktop(maxDepth: Int, windowIds: Set<CGWindowID>?) throws -> [String: Any] {
    guard isTrusted() else {
      throw RPCError(.permissionDenied, "Accessibility is not granted to this app")
    }
    let windows = Windows.list().filter { window in
      // A minimized or off-screen window has no useful geometry for the agent to
      // act on, and walking it costs the same as a visible one.
      guard window.onScreen, !window.minimized else { return false }
      guard let windowIds else { return true }
      return windowIds.contains(window.windowNumber)
    }

    // One AX application element per distinct owning pid, reused across its
    // windows, together with that app's window list (one IPC, not one per
    // window). `AXManualAccessibility` is poked so Chromium/Electron targets
    // expose a tree at all, and `AXEnhancedUserInterface` is turned on for the
    // walk because many apps only publish their full hierarchy with it — then
    // restored, because leaving it on makes some apps resize their windows.
    var applications: [pid_t: Application] = [:]
    defer { for application in applications.values { application.restore() } }

    var children: [[String: Any]] = []
    var remaining = maxNodesPerDesktop
    for window in windows {
      if remaining <= 0 { break }
      let application: Application
      if let existing = applications[window.ownerPID] {
        application = existing
      } else {
        application = Application(pid: window.ownerPID)
        applications[window.ownerPID] = application
      }
      guard let axWindow = application.match(window) else { continue }
      AXUIElementSetMessagingTimeout(axWindow, windowMessagingTimeout)

      var budget = Budget(remaining: min(maxNodesPerWindow, remaining))
      guard
        var windowNode = node(
          from: axWindow,
          windowId: window.windowNumber,
          windowBounds: window.bounds,
          depth: 0,
          maxDepth: maxDepth,
          path: [],
          budget: &budget)
      else { continue }
      if budget.truncated { windowNode["truncated"] = true }
      remaining -= budget.used
      children.append(windowNode)
    }

    let workspace = Geometry.workspaceRect()
    return [
      "root": [
        "role": "desktop",
        "label": NSNull(),
        "value": NSNull(),
        "description": "macOS desktop",
        "frame": Geometry.rectDictionary(workspace),
        "onScreen": true,
        "children": children,
      ]
    ]
  }

  /// Resolve `windowId` + `nodePath` to a live element and set its value.
  static func setValue(windowId: CGWindowID, path: [Int], value: String) throws {
    let element = try resolve(windowId: windowId, path: path)
    let status = AXUIElementSetAttributeValue(
      element, kAXValueAttribute as CFString, value as CFTypeRef)
    guard status == .success else {
      throw RPCError(.notDelivered, "the control refused a value write (AX error \(status.rawValue))")
    }
  }

  /// Resolve `windowId` + `nodePath` to a live element and perform an action.
  static func performAction(windowId: CGWindowID, path: [Int], action: String) throws {
    let element = try resolve(windowId: windowId, path: path)
    let axAction = mapAction(action)
    let status = AXUIElementPerformAction(element, axAction as CFString)
    guard status == .success else {
      throw RPCError(
        .notDelivered, "the control refused action \(action) (AX error \(status.rawValue))")
    }
  }

  /// `AXRaise` on the matching AX window: raises it within its application
  /// without activating that application, which is the difference between
  /// bringing a window forward and stealing the human's focus. Returns whether
  /// the action was accepted; the caller still verifies the stacking.
  static func raise(_ window: DesktopWindow) -> Bool {
    guard isTrusted() else { return false }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    guard let axWindow = application.match(window) else { return false }
    return AXUIElementPerformAction(axWindow, kAXRaiseAction as CFString) == .success
  }

  /// The outcome of the accessibility typing rung.
  enum TextInsertion {
    /// The focused element accepted the text. `verified` is true only when its
    /// value could be read back and contains the text — never for web content,
    /// whose accessibility value is a renderer-side mirror the ledger treats as
    /// untrusted.
    case inserted(verified: Bool)
    /// No focused text element in that app: this rung does not apply.
    case notApplicable
    /// The element exists but refused the write; the caller falls through.
    case refused(String)
  }

  /// Bundle ids of terminal emulators. An `AXSelectedText` write into a terminal
  /// view lands in the accessibility mirror and never reaches the pty, so the
  /// typing ladder must skip this rung for them.
  private static let terminalBundleIDs: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "io.alacritty", "co.zeit.hyper",
    "com.github.wez.wezterm",
  ]

  private static let textRoles: Set<String> = [
    kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField", "AXSecureTextField",
  ]

  /// Insert `text` at the caret of the focused text element in `window`'s
  /// application by writing `AXSelectedText`: an atomic, background-safe write
  /// that native controls and web views both implement. Applies only when the
  /// app's focused element is a text control (or lives inside a web area) and
  /// the app is not a terminal.
  static func insertText(_ text: String, into window: DesktopWindow) -> TextInsertion {
    guard isTrusted() else { return .notApplicable }
    if let bundle = NSRunningApplication(processIdentifier: window.ownerPID)?.bundleIdentifier,
      terminalBundleIDs.contains(bundle)
    {
      return .notApplicable
    }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return .notApplicable }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    let role = stringAttribute(focused, kAXRoleAttribute) ?? ""
    let inWebArea = hasAncestor(focused, role: "AXWebArea")
    guard textRoles.contains(role) || inWebArea else { return .notApplicable }
    guard isSettable(focused, kAXSelectedTextAttribute) else { return .notApplicable }
    let status = AXUIElementSetAttributeValue(
      focused, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
    guard status == .success else {
      return .refused("AX error \(status.rawValue)")
    }
    // Web content is deliberately never accepted here, even though the write
    // above reports success. A Chromium/Electron accessibility value is a
    // renderer-side mirror: setting it satisfies AX without the page ever
    // seeing an input event, so this rung used to report `inserted` for a form
    // field that stayed empty — and because the ladder returns on any
    // `inserted`, the reliable rungs below never ran. An unverifiable rung is
    // worse than no rung, so it declines and lets keystrokes do the work.
    if inWebArea { return .refused("accessibility writes into web content cannot be verified") }
    let after = stringAttribute(focused, kAXValueAttribute) ?? ""
    return .inserted(verified: after.contains(text))
  }

  /// The target's focused element's current value, or nil when there is none to
  /// read. Callers compare before and after a keystroke rung to tell a delivery
  /// that landed from one that did not. Web content exposes no usable value, so
  /// nil there means unproven rather than failed.
  ///
  /// The distinction is load-bearing, which is why the missing-value case
  /// returns nil rather than the empty string it used to. An element with no
  /// readable `AXValue` read back as `""` both before and after the keystrokes,
  /// which is indistinguishable from a field that stayed empty — so the ladder
  /// concluded "not delivered", climbed to the visible rung, and typed the whole
  /// string a second time.
  static func focusedValue(in window: DesktopWindow) -> String? {
    guard isTrusted() else { return nil }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    return stringAttribute(focused, kAXValueAttribute)
  }

  /// Whether what the target application currently considers focused lives in a
  /// web view.
  ///
  /// The typing ladder asks this before it spends anything on the invisible
  /// rungs: a focused web control neither accepts a verifiable accessibility
  /// write nor receives pid-posted keys, so both rungs are known in advance to
  /// be wasted keystrokes into a page that will not see them. Distinct from
  /// `pointIsWebContent`, which asks about the surface under the pointer — a
  /// keyboard action has no pointer.
  static func focusedElementIsWebContent(in window: DesktopWindow) -> Bool {
    guard isTrusted() else { return false }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return false }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    if stringAttribute(focused, kAXRoleAttribute) == "AXWebArea" { return true }
    return hasAncestor(focused, role: "AXWebArea")
  }

  /// Whether the surface under a screen point is web content.
  ///
  /// This is the one property that reliably predicts a dropped background
  /// gesture. Chromium and Electron accept pid-posted mouse input only once
  /// their application is genuinely frontmost — measured directly — while native
  /// AppKit surfaces accept it in the background. Verification cannot decide it
  /// after the fact: a click on an already-focused field changes nothing
  /// observable whether it landed or not, which is exactly the common case in a
  /// form.
  ///
  /// It is deliberately asked of the element under the pointer rather than of
  /// the process, because one process is often both: Chrome's tab strip and
  /// omnibox are native AppKit in the same pid as the page, and only the page
  /// needs the visible rung.
  static func pointIsWebContent(_ point: CGPoint, in window: DesktopWindow) -> Bool {
    guard isTrusted() else { return false }
    // Explicitly without the enhanced-user-interface toggle. This runs before
    // essentially every gesture, and the default would flip
    // `AXEnhancedUserInterface` on the target and back again each time — a
    // setting some applications relayout their whole window for.
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    var raw: AXUIElement?
    guard
      AXUIElementCopyElementAtPosition(
        application.element, Float(point.x), Float(point.y), &raw) == .success,
      let hit = raw
    else { return false }
    AXUIElementSetMessagingTimeout(hit, windowMessagingTimeout)
    if stringAttribute(hit, kAXRoleAttribute) == "AXWebArea" { return true }
    return hasAncestor(hit, role: "AXWebArea")
  }

  /// The element under a screen point, and whether it is something a click would
  /// be expected to focus. Used to decide whether a delivery probe is entitled
  /// to conclude anything at all.
  static func focusExpectation(at point: CGPoint, in window: DesktopWindow)
    -> (element: String, alreadyFocused: Bool)?
  {
    guard isTrusted() else { return nil }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    var raw: AXUIElement?
    guard
      AXUIElementCopyElementAtPosition(
        application.element, Float(point.x), Float(point.y), &raw) == .success,
      let hit = raw
    else { return nil }
    AXUIElementSetMessagingTimeout(hit, windowMessagingTimeout)
    // Only a focusable element gives the probe an expectation to test. A click
    // on a label, a background, or a static image legitimately moves nothing.
    guard boolAttribute(hit, kAXFocusedAttribute as String) != nil else { return nil }
    let signature = signature(of: hit)
    return (signature, signature == focusedElementSignature(in: window))
  }

  private static func signature(of element: AXUIElement) -> String {
    let role = stringAttribute(element, kAXRoleAttribute) ?? ""
    let title = stringAttribute(element, kAXTitleAttribute) ?? ""
    let text = stringAttribute(element, kAXValueAttribute) ?? ""
    let box = frame(of: element).map { "\($0.origin.x),\($0.origin.y),\($0.width),\($0.height)" }
      ?? ""
    return "\(role)|\(title)|\(text)|\(box)"
  }

  /// A cheap identity for whatever the app currently considers focused: role
  /// plus title plus value plus frame. Compared before and after a gesture to
  /// tell a click that landed from one that went nowhere. Nil when the app
  /// exposes no focused element, which is not evidence either way.
  static func focusedElementSignature(in window: DesktopWindow) -> String? {
    guard isTrusted() else { return nil }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    return signature(of: focused)
  }

  private static func hasAncestor(_ element: AXUIElement, role: String) -> Bool {
    var current = element
    for _ in 0..<12 {
      var raw: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &raw) == .success,
        let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
      else { return false }
      // swiftlint:disable:next force_cast
      current = value as! AXUIElement
      if stringAttribute(current, kAXRoleAttribute) == role { return true }
    }
    return false
  }

  /// Point the target app's own key routing at `window` before keys are posted
  /// to it. An app that is not the active app still tracks which of its windows
  /// is main/focused, and a background window that is neither routinely drops
  /// keystrokes. Best effort: every error is ignored, since the post itself is
  /// what actually delivers.
  static func focusWindow(_ window: DesktopWindow) {
    guard isTrusted() else { return }
    let application = Application(pid: window.ownerPID, enhanceUserInterface: false)
    defer { application.restore() }
    guard let axWindow = application.match(window) else { return }
    AXUIElementSetAttributeValue(axWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(axWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  }

  // MARK: - Application handle

  /// One application element plus the bookkeeping that must be undone after the
  /// walk. Created per pid per request; `restore()` is idempotent.
  private final class Application {
    let element: AXUIElement
    private var windows: [AXUIElement]?
    private var previousEnhanced: Bool?
    private var enhanced = false

    init(pid: pid_t, enhanceUserInterface: Bool = true) {
      element = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(element, applicationMessagingTimeout)
      // Chromium/Electron expose no AX tree until asked; harmless elsewhere.
      AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      guard enhanceUserInterface else { return }
      previousEnhanced = boolAttribute(element, "AXEnhancedUserInterface")
      if previousEnhanced != true {
        AXUIElementSetAttributeValue(
          element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        enhanced = true
      }
    }

    /// The app's windows, fetched once however many desktop windows it owns.
    func match(_ window: DesktopWindow) -> AXUIElement? {
      let candidates = windows ?? attributeElements(element, kAXWindowsAttribute)
      windows = candidates
      return matchWindow(candidates, to: window)
    }

    /// Put `AXEnhancedUserInterface` back the way it was found. Leaving it on
    /// makes some apps (AppKit apps with auto-resizing windows especially)
    /// visibly jump the next time they lay out.
    func restore() {
      guard enhanced else { return }
      enhanced = false
      AXUIElementSetAttributeValue(
        element, "AXEnhancedUserInterface" as CFString,
        (previousEnhanced ?? false) ? kCFBooleanTrue : kCFBooleanFalse)
    }
  }

  // MARK: - Walk

  /// Node accounting for one window: how many more nodes may be emitted, and
  /// whether the cap actually cut the tree short.
  private struct Budget {
    var remaining: Int
    var used = 0
    var truncated = false
  }

  private struct Snapshot {
    var role = "AXUnknown"
    var title: String?
    var detail: String?
    var value: String?
    var frame: CGRect?
    var children: [AXUIElement] = []
  }

  private static func node(
    from element: AXUIElement,
    windowId: CGWindowID,
    windowBounds: CGRect,
    depth: Int,
    maxDepth: Int,
    path: [Int],
    budget: inout Budget
  ) -> [String: Any]? {
    guard budget.remaining > 0 else {
      budget.truncated = true
      return nil
    }
    let snapshot = read(element)
    let frame = snapshot.frame ?? .zero
    // Off-screen scroll content: a real frame that misses the window entirely is
    // not something the agent can act on, and those subtrees are where the node
    // count explodes. A zero-size node is a layout container, not a position, so
    // it is still descended.
    if depth > 0, frame.width > 0, frame.height > 0, !frame.intersects(windowBounds) {
      return nil
    }
    budget.remaining -= 1
    budget.used += 1

    var children: [[String: Any]] = []
    if depth < maxDepth {
      for (index, child) in snapshot.children.enumerated() {
        // The child's index is its real position among its siblings even when a
        // sibling was skipped, so `nodePath` stays a valid re-resolve route.
        if let childNode = node(
          from: child,
          windowId: windowId,
          windowBounds: windowBounds,
          depth: depth + 1,
          maxDepth: maxDepth,
          path: path + [index],
          budget: &budget)
        {
          children.append(childNode)
        }
        if budget.remaining <= 0 {
          // The cap cut this window's tree short only if there was more to emit.
          if index < snapshot.children.count - 1 { budget.truncated = true }
          break
        }
      }
    }

    var payload: [String: Any] = [
      "role": snapshot.role,
      "label": (snapshot.title ?? snapshot.detail) as Any? ?? NSNull(),
      "value": snapshot.value as Any? ?? NSNull(),
      "description": snapshot.detail as Any? ?? NSNull(),
      "frame": Geometry.rectDictionary(frame),
      "activationPoint": [
        "x": Double(frame.midX),
        "y": Double(frame.midY),
      ],
      "onScreen": true,
      "windowId": String(windowId),
      "editable": valueBearingRoles.contains(snapshot.role)
        && isSettable(element, kAXValueAttribute),
      "children": children,
    ]
    // The window root is addressed by its window id alone; every node below it
    // carries the absolute child-index route from that root.
    if depth > 0 { payload["nodePath"] = path }
    return payload
  }

  /// Every attribute this walk needs, in one IPC round trip.
  private static func read(_ element: AXUIElement) -> Snapshot {
    var snapshot = Snapshot()
    var raw: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, nodeAttributes, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
      let values = raw as? [Any], values.count == 7
    else { return snapshot }
    if let role = string(values[0]) { snapshot.role = role }
    snapshot.title = string(values[1])
    snapshot.detail = string(values[2])
    snapshot.value = string(values[3])
    if let origin = axPoint(values[4]), let size = axSize(values[5]) {
      snapshot.frame = CGRect(origin: origin, size: size)
    }
    snapshot.children = values[6] as? [AXUIElement] ?? []
    return snapshot
  }

  // MARK: - Internals

  private static func mapAction(_ action: String) -> String {
    switch action {
    case "press", "click", "activate": return kAXPressAction
    case "increment": return kAXIncrementAction
    case "decrement": return kAXDecrementAction
    case "showMenu": return kAXShowMenuAction
    default: return action
    }
  }

  private static func resolve(windowId: CGWindowID, path: [Int]) throws -> AXUIElement {
    guard isTrusted() else {
      throw RPCError(.permissionDenied, "Accessibility is not granted to this app")
    }
    guard let window = Windows.window(withNumber: windowId) else {
      throw RPCError(.targetMissing, "no window has id \(windowId)")
    }
    let application = Application(pid: window.ownerPID)
    defer { application.restore() }
    guard let axWindow = application.match(window) else {
      throw RPCError(.targetMissing, "no accessibility window matched id \(windowId)")
    }
    var current = axWindow
    for index in path {
      let kids = attributeElements(current, kAXChildrenAttribute)
      guard index >= 0, index < kids.count else {
        throw RPCError(.targetMissing, "node path left the tree at index \(index)")
      }
      current = kids[index]
    }
    return current
  }

  /// `_AXUIElementGetWindow` — the private call that maps an AX window element
  /// to its `CGWindowID`. Resolved at runtime with the same posture as the
  /// SkyLight SPI: absent means fall back, never crash.
  private typealias GetWindowID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) ->
    AXError
  private static let getWindowID: GetWindowID? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow")
    else {
      logDiagnostic("_AXUIElementGetWindow is missing; AX windows match on title/frame instead")
      return nil
    }
    return unsafeBitCast(symbol, to: GetWindowID.self)
  }()

  private static func windowID(of element: AXUIElement) -> CGWindowID? {
    guard let getWindowID else { return nil }
    var identifier: CGWindowID = 0
    return getWindowID(element, &identifier) == .success ? identifier : nil
  }

  /// Pick the AX window that matches a `CGWindow`.
  ///
  /// By window id where the OS will tell us, because that is the only exact
  /// answer. Title was the first key here, and two windows of one app sharing a
  /// title — two "Untitled" TextEdit documents, two Terminal tabs named "bash" —
  /// both resolved to whichever came first: perception described one window
  /// twice, and a `set-value` addressed at the second wrote into the first.
  /// Title is still consulted, but only when it is unambiguous.
  private static func matchWindow(_ candidates: [AXUIElement], to window: DesktopWindow)
    -> AXUIElement?
  {
    if candidates.isEmpty { return nil }
    for candidate in candidates where windowID(of: candidate) == window.windowNumber {
      return candidate
    }
    if !window.title.isEmpty {
      let titled = candidates.filter {
        stringAttribute($0, kAXTitleAttribute) == window.title
      }
      // Exactly one match is an answer; several is the ambiguity that made this
      // wrong, so those fall through to the frame overlap below.
      if titled.count == 1 { return titled[0] }
    }
    var best: AXUIElement?
    var bestArea: CGFloat = -1
    for candidate in candidates {
      guard let frame = frame(of: candidate) else { continue }
      let overlap = frame.intersection(window.bounds)
      let area = overlap.isNull ? 0 : overlap.width * overlap.height
      if area > bestArea {
        bestArea = area
        best = candidate
      }
    }
    return best
  }

  private static func attributeElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]
  {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
      let array = value as? [AXUIElement]
    else { return [] }
    return array
  }

  private static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
    else { return nil }
    return string(value as Any)
  }

  private static func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
    else { return nil }
    return (value as? NSNumber)?.boolValue
  }

  private static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
    else { return false }
    return settable.boolValue
  }

  private static func frame(of element: AXUIElement) -> CGRect? {
    var raw: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, [kAXPositionAttribute, kAXSizeAttribute] as CFArray,
        AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
      let values = raw as? [Any], values.count == 2,
      let origin = axPoint(values[0]), let size = axSize(values[1])
    else { return nil }
    return CGRect(origin: origin, size: size)
  }

  // MARK: - Value decoding
  //
  // A failed attribute inside a multi-value read comes back as an `AXValue` of
  // type `.axError` rather than a hole, so every decoder simply refuses
  // anything that is not the type it wants.

  private static func string(_ value: Any) -> String? {
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
  }

  private static func axValue(_ value: Any, _ type: AXValueType) -> AXValue? {
    let object = value as CFTypeRef
    guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
    // swiftlint:disable:next force_cast
    let axValue = object as! AXValue
    return AXValueGetType(axValue) == type ? axValue : nil
  }

  private static func axPoint(_ value: Any) -> CGPoint? {
    guard let wrapper = axValue(value, .cgPoint) else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(wrapper, .cgPoint, &point) else { return nil }
    return point
  }

  private static func axSize(_ value: Any) -> CGSize? {
    guard let wrapper = axValue(value, .cgSize) else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(wrapper, .cgSize, &size) else { return nil }
    return size
  }
}
