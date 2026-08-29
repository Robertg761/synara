// Non-disruptive synthetic input.
//
// This is the whole trick, and it is the literal port of what Codex does on
// macOS (confirmed by the reverse-engineering in the design reference):
//
//   1. Build a CGEvent for the action at the global location.
//   2. Stamp its private integer fields — button (3), subtype (7=3), and the
//      target window id (91, 92).
//   3. Call the private `CGEventSetWindowLocation` with window-local
//      coordinates. This one call is what delivers the event to a background
//      window; without it nothing arrives.
//   4. Post it to the *target process* with `CGEventPostToPid`, never to the HID
//      tap. WindowServer warps the real pointer only as a side effect of
//      HID-stream events, so posting to a pid keeps the human's cursor still.
//
// The real cursor is never touched: no `CGWarpMouseCursorPosition`, no HID-tap
// posting. The agent's visible cursor is the overlay in Cursor.swift, moved in
// lockstep with these posts.
//
// `CGEventSetWindowLocation` is private, so it is resolved with dlsym at runtime
// rather than linked — a moved symbol becomes a diagnosable capability gap, not
// a dyld crash, and the binary stays relocatable (the same posture the device
// helper takes with its private frameworks).

import ApplicationServices
import CoreGraphics
import Foundation

/// Private CoreGraphics field numbers, from the reference teardown.
private let kFieldButtonNumber = CGEventField(rawValue: 3)!
private let kFieldSubtype = CGEventField(rawValue: 7)!
private let kFieldWindowIDLow = CGEventField(rawValue: 91)!
private let kFieldWindowIDHigh = CGEventField(rawValue: 92)!
private let kWindowEventSubtype: Int64 = 3

private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void

final class InputController {
  /// Resolved once; nil means the private symbol is gone on this OS and
  /// background window targeting is unavailable, which the caller reports rather
  /// than silently posting to the wrong place.
  private let setWindowLocation: SetWindowLocation?
  private let source: CGEventSource?
  private let cursor: AgentCursor

  /// The window keyboard input is currently aimed at, set by the last pointer
  /// action. Re-stamped before every key so a target change mid-type cannot pull
  /// the agent's remaining keystrokes into another window (the macOS analog of
  /// the Linux keyboard re-stamp fix).
  private var keyboardTarget: DesktopWindow?

  init(cursor: AgentCursor) {
    self.cursor = cursor
    let handle = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation")
    self.setWindowLocation = handle.map { unsafeBitCast($0, to: SetWindowLocation.self) }

    let source = CGEventSource(stateID: .privateState)
    // Disarm the API's hostile defaults: without this every posted event freezes
    // the human's real input for 0.25s, and a synthetic mouse-down freezes their
    // mouse until the matching up.
    source?.setLocalEventsFilterDuringSuppressionState(
      [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents],
      state: .eventSuppressionStateSuppressionInterval)
    source?.setLocalEventsFilterDuringSuppressionState(
      [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents],
      state: .eventSuppressionStateRemoteMouseDrag)
    self.source = source
  }

  // MARK: - Pointer

  func move(to point: CGPoint) {
    cursor.move(to: point)
    keyboardTarget = Windows.topmost(at: point)
  }

  func click(at point: CGPoint, button: CGMouseButton = .left, count: Int = 1) throws {
    move(to: point)
    for _ in 0..<max(1, count) {
      try postMouse(.leftMouseDown, at: point, button: button)
      try postMouse(.leftMouseUp, at: point, button: button)
    }
  }

  func rightClick(at point: CGPoint) throws {
    move(to: point)
    try postMouse(.rightMouseDown, at: point, button: .right)
    try postMouse(.rightMouseUp, at: point, button: .right)
  }

  func drag(from: CGPoint, to: CGPoint, durationMs: Int) throws {
    move(to: from)
    try postMouse(.leftMouseDown, at: from, button: .left)
    // At least a few intermediate dragged events, or a drag silently degrades to
    // a click in many toolkits (reference §4.4).
    let steps = max(3, min(60, durationMs / 12))
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t)
      cursor.move(to: point)
      try postMouse(.leftMouseDragged, at: point, button: .left)
      usleep(useconds_t(max(1, durationMs / steps) * 1000))
    }
    try postMouse(.leftMouseUp, at: to, button: .left)
    cursor.move(to: to)
  }

  func scroll(at point: CGPoint?, deltaX: Double, deltaY: Double) throws {
    if let point { move(to: point) }
    let target = point.flatMap { Windows.topmost(at: $0) } ?? keyboardTarget
    // Scroll deltas are in pixels; a positive dy scrolls toward the content end,
    // matching the wire convention. Line units are negated the way a wheel is.
    guard
      let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(-deltaY),
        wheel2: Int32(-deltaX),
        wheel3: 0)
    else { throw RPCError(.internalError, "could not build a scroll event") }
    if let point { event.location = point }
    try deliver(event, to: target, localPoint: point.map { localPoint($0, in: target) })
  }

  // MARK: - Keyboard

  func typeText(_ text: String) throws {
    let target = keyboardTarget ?? frontmostWindow()
    // 20 UTF-16 units per chunk: delivery truncates past ~20 (reference §4.4).
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
      let end = min(index + 20, units.count)
      let chunk = Array(units[index..<end])
      try postUnicode(chunk, to: target)
      index = end
    }
  }

  func pressKey(_ key: String, modifiers: [String]) throws {
    guard let code = KeyMap.code(for: key) else {
      throw RPCError(.invalidParams, "unknown key '\(key)'")
    }
    let flags = KeyMap.flags(for: modifiers)
    let target = keyboardTarget ?? frontmostWindow()
    try postKey(code, down: true, flags: flags, to: target)
    try postKey(code, down: false, flags: flags, to: target)
  }

  func hotkey(_ keys: [String]) throws {
    var modifiers: [String] = []
    var mainKey: String?
    for key in keys {
      if KeyMap.isModifier(key) {
        modifiers.append(key)
      } else {
        mainKey = key
      }
    }
    guard let mainKey, let code = KeyMap.code(for: mainKey) else {
      throw RPCError(.invalidParams, "hotkey needs one non-modifier key")
    }
    let flags = KeyMap.flags(for: modifiers)
    let target = keyboardTarget ?? frontmostWindow()
    try postKey(code, down: true, flags: flags, to: target)
    try postKey(code, down: false, flags: flags, to: target)
  }

  // MARK: - Delivery

  private func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton) throws {
    guard
      let event = CGEvent(
        mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    else { throw RPCError(.internalError, "could not build a mouse event") }
    let target = Windows.topmost(at: point)
    keyboardTarget = target
    try deliver(event, to: target, localPoint: localPoint(point, in: target))
  }

  private func postUnicode(_ units: [UniChar], to target: DesktopWindow?) throws {
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
        throw RPCError(.internalError, "could not build a keyboard event")
      }
      event.flags = []
      var mutable = units
      event.keyboardSetUnicodeString(stringLength: mutable.count, unicodeString: &mutable)
      try deliver(event, to: target, localPoint: nil)
    }
  }

  private func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, to target: DesktopWindow?)
    throws
  {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw RPCError(.internalError, "could not build a keyboard event")
    }
    event.flags = flags
    try deliver(event, to: target, localPoint: nil)
  }

  /// Stamp the window fields and window-local location, then post to the target
  /// pid. With no target (bare desktop) the event still posts to the frontmost
  /// app, which is the honest best effort for an unscoped action.
  private func deliver(_ event: CGEvent, to target: DesktopWindow?, localPoint: CGPoint?) throws {
    if let target {
      event.setIntegerValueField(kFieldSubtype, value: kWindowEventSubtype)
      event.setIntegerValueField(kFieldWindowIDLow, value: Int64(target.windowNumber))
      event.setIntegerValueField(kFieldWindowIDHigh, value: Int64(target.windowNumber))
      if let localPoint, let setWindowLocation {
        setWindowLocation(event, localPoint)
      }
      event.postToPid(target.ownerPID)
    } else if let pid = frontmostWindow()?.ownerPID {
      event.postToPid(pid)
    } else {
      event.post(tap: .cgSessionEventTap)
    }
  }

  private func localPoint(_ global: CGPoint, in target: DesktopWindow?) -> CGPoint {
    guard let target else { return global }
    return CGPoint(x: global.x - target.bounds.origin.x, y: global.y - target.bounds.origin.y)
  }

  private func frontmostWindow() -> DesktopWindow? {
    Windows.list().first
  }
}

/// US-ANSI key-name → virtual keycode map, plus modifier handling.
///
/// Named keys (enter, tab, arrows, function keys) need real keycodes so
/// modifiers and shortcuts dispatch; single printable characters map through the
/// same table where they are ANSI, and fall back to the Unicode-string path in
/// `typeText` for anything else (layout-independent, no AZERTY/Dvorak handling).
enum KeyMap {
  private static let named: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  private static let ansi: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50, " ": 49,
  ]

  static func isModifier(_ key: String) -> Bool {
    switch key.lowercased() {
    case "cmd", "command", "meta", "super", "win", "shift", "alt", "option", "opt", "ctrl",
      "control", "fn":
      return true
    default:
      return false
    }
  }

  static func flags(for modifiers: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
      switch modifier.lowercased() {
      case "cmd", "command", "meta", "super", "win": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "alt", "option", "opt": flags.insert(.maskAlternate)
      case "ctrl", "control": flags.insert(.maskControl)
      case "fn": flags.insert(.maskSecondaryFn)
      default: break
      }
    }
    return flags
  }

  static func code(for key: String) -> CGKeyCode? {
    let trimmed = key.trimmingCharacters(in: .whitespaces)
    if let named = named[trimmed.lowercased()] { return named }
    if trimmed.count == 1, let character = trimmed.lowercased().first, let code = ansi[character] {
      return code
    }
    return nil
  }
}
