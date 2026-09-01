// synara-computer-helper — the native side of Synara's macOS computer use.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio (one object per line),
// the same wire the device helper and Codex app-server speak, so the Node side
// reuses `@synara/shared/jsonrpc-stdio`. There is no frame socket: Tier-1
// capture is a whole-desktop PNG still that the Node backend publishes on a
// timer, exactly as the KWin backend does.
//
// Requests are read on the stdin thread and run on one of three lanes (see
// Dispatch.swift): input in arrival order, perception concurrently, the AX walk
// alone. Responses may therefore complete out of order — the id correlates them
// and `writeMessage` serialises the writes.
//
// Every coordinate on the wire is global top-left screen points. See
// Geometry.swift, and docs/computer-use-macos-reference.md for the mechanism.

import AppKit
import Foundation

let arguments = CommandLine.arguments

// One-shot permission commands never start the JSON-RPC server or overlay.
if arguments.contains("--probe") || arguments.contains("--request-permissions") {
  var payload = arguments.contains("--request-permissions")
    ? Capability.requestPermissions()
    : Capability.report()
  payload["ok"] = true
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(0)
}

// The app must be an accessory (no Dock icon, no menu bar) so a background helper
// that draws an overlay never steals activation or appears as a running app.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let cursor = AgentCursor()
cursor.install()
let input = InputController(cursor: cursor)

// MARK: - Dispatch

func handle(method: String, params: Params) throws -> Any {
  switch method {
  case "ping":
    return ["ok": true, "pid": ProcessInfo.processInfo.processIdentifier]

  case "capabilities":
    return Capability.report()

  case "list-windows":
    // The helper's own overlay is not in this list, and must not be: see
    // Windows.swift.
    let windows = Windows.list()
    let payload = windows.map { window in
      Windows.dictionary(window, occluders: Windows.occluders(of: window, in: windows))
    }
    return [
      "windows": payload,
      "workspace": Geometry.rectDictionary(Geometry.workspaceRect()),
      // The frontmost on-screen application window is the focus target. The
      // list also carries minimized windows, which can never hold focus.
      "focusedWindowId": windows.first { $0.onScreen }.map { String($0.windowNumber) } as Any?
        ?? NSNull(),
    ]

  case "screen-size":
    let rect = Geometry.workspaceRect()
    var payload = Geometry.rectDictionary(rect)
    payload["scale"] = Double(Geometry.scaleFactor(for: rect))
    return payload

  case "describe-ui":
    return try Accessibility.describeDesktop(
      maxDepth: params.optionalInt("maxDepth", default: 40),
      windowIds: windowIdSet(from: params, key: "windowIds"))

  case "capture":
    let maxDimension = params.optionalInt("maxDimension", default: 2048)
    let prefer = params.optionalString("source").flatMap { Capture.Source(rawValue: $0) }
    let kind = try params.string("kind")
    let result: Capture.Result
    switch kind {
    case "window":
      let windowId = try params.string("windowId")
      guard let number = UInt32(windowId) else {
        throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
      }
      result = try Capture.window(
        CGWindowID(number), maxDimension: maxDimension, prefer: prefer)
    case "region":
      guard let rect = params.rect("region") else {
        throw RPCError(.invalidParams, "region capture needs a {x,y,width,height} rect")
      }
      result = try Capture.region(rect, maxDimension: maxDimension, prefer: prefer)
    default:
      throw RPCError(.invalidParams, "capture kind must be 'window' or 'region'")
    }
    return [
      "base64": result.pngBase64,
      "region": Geometry.rectDictionary(result.region),
      // Which link of the capture chain served this, so the backend can track
      // the fallback rate as a health metric.
      "source": result.source.rawValue,
    ]

  case "launch-app":
    return try launchApp(app: try params.string("app"), arguments: params.stringArray("arguments"))

  case "move":
    let point = try point(from: params)
    try input.move(to: point, window: optionalWindowId(from: params))
    return ["x": Double(point.x), "y": Double(point.y)]

  case "click":
    let point = try point(from: params)
    try input.click(at: point, window: optionalWindowId(from: params))
    return ["x": Double(point.x), "y": Double(point.y)]

  case "double-click":
    let point = try point(from: params)
    try input.click(at: point, count: 2, window: optionalWindowId(from: params))
    return ["x": Double(point.x), "y": Double(point.y)]

  case "right-click":
    let point = try point(from: params)
    try input.rightClick(at: point, window: optionalWindowId(from: params))
    return ["x": Double(point.x), "y": Double(point.y)]

  case "drag":
    let from = Geometry.clampToWorkspace(
      CGPoint(x: try params.double("fromX"), y: try params.double("fromY")))
    let to = Geometry.clampToWorkspace(
      CGPoint(x: try params.double("toX"), y: try params.double("toY")))
    // Background drag is best effort (no toolkit in the reference ledger delivers
    // it); `foreground: true` brings the target forward for the gesture instead.
    let mode: DeliveryMode = (params.raw["foreground"] as? Bool) == true ? .foreground : .background
    // The rung that ran, not the one requested: a background drag into an app
    // known to drop them is promoted, and reporting the request would tell the
    // agent the gesture was invisible when it was not.
    let resolved = try input.drag(
      from: from, to: to, durationMs: params.optionalInt("durationMs", default: 220), mode: mode,
      window: optionalWindowId(from: params))
    return ["ok": true, "path": resolved.rawValue]

  case "scroll":
    let x = params.optionalDouble("x")
    let y = params.optionalDouble("y")
    let point =
      (x != nil && y != nil) ? Geometry.clampToWorkspace(CGPoint(x: x!, y: y!)) : nil
    try input.scroll(
      at: point, deltaX: try params.double("deltaX"), deltaY: try params.double("deltaY"),
      window: optionalWindowId(from: params))
    return ["ok": true]

  case "type":
    let outcome = try input.typeText(
      try params.text("text"), mode: try DeliveryMode(param: params.optionalString("deliveryMode")))
    return ["ok": true, "path": outcome.path, "verified": outcome.verified]

  case "press-key":
    let path = try input.pressKey(
      try params.string("key"), modifiers: params.stringArray("modifiers"),
      mode: try DeliveryMode(param: params.optionalString("deliveryMode")))
    return ["ok": true, "path": path]

  case "hotkey":
    let keys = params.stringArray("keys")
    guard !keys.isEmpty else { throw RPCError(.invalidParams, "hotkey needs a non-empty keys array") }
    let path = try input.hotkey(
      keys, mode: try DeliveryMode(param: params.optionalString("deliveryMode")))
    return ["ok": true, "path": path]

  case "set-value":
    let windowId = try windowId(from: params)
    try Accessibility.setValue(
      windowId: windowId, path: intArray(params, "nodePath"), value: try params.text("value"))
    return ["ok": true]

  case "perform-action":
    let windowId = try windowId(from: params)
    try Accessibility.performAction(
      windowId: windowId, path: intArray(params, "nodePath"), action: try params.string("action"))
    return ["ok": true]

  case "focus-window":
    // Point the keyboard at a window without touching stacking or activation.
    // This is what the Node side asks for before typing: the agent named a
    // window, and the keys must go there whatever the last pointer gesture
    // aimed at — but wanting to type into a window is not a reason to pull it
    // in front of whatever the human is looking at.
    let focusId = try windowId(from: params)
    guard let focusTarget = Windows.window(withNumber: focusId) else {
      throw RPCError(.targetMissing, "no window has id \(focusId)")
    }
    input.setKeyboardTarget(focusTarget)
    Accessibility.focusWindow(focusTarget)
    return ["ok": true]

  case "raise-window":
    try raiseWindow(windowId: try windowId(from: params))
    return ["ok": true]

  case "read-clipboard":
    // Truncate at the source. A clipboard holding a whole document would
    // otherwise be base64'd through the line framer before the Node side got a
    // chance to refuse it.
    let clipboard = NSPasteboard.general.string(forType: .string) ?? ""
    let maxBytes = params.optionalInt("maxBytes", default: 0)
    if maxBytes > 0, clipboard.utf8.count > maxBytes {
      return ["text": "", "truncated": true, "byteLength": clipboard.utf8.count]
    }
    return ["text": clipboard, "truncated": false]

  case "write-clipboard":
    // Read the parameter before clearing: validating afterwards destroyed the
    // human's clipboard and then failed the call.
    let clipboardText = try params.text("text")
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(clipboardText, forType: .string)
    return ["ok": true]

  case "set-agent-cursor":
    cursor.setName(params.optionalString("name") ?? "")
    return ["ok": true]

  default:
    throw RPCError(.methodNotFound, "unknown method '\(method)'")
  }
}

// MARK: - Method helpers

/// A requested point, clamped onto the desktop.
///
/// The helper used to echo whatever it was given, which made the backend's
/// `clampedTo` reporting structurally dead: request and answer were the same
/// number by construction. Worse, a coordinate off the desktop resolved no
/// target window and the action silently did nothing. Clamping onto the
/// workspace makes the action land somewhere real and makes the echoed point an
/// honest answer to "where did this go", which is what the backend compares.
/// The window the caller named for this action, if any. Absent means "whatever is
/// topmost at the point", which is how a bare coordinate behaves.
func optionalWindowId(from params: Params) -> CGWindowID? {
  guard let raw = params.optionalString("windowId"), let number = UInt32(raw) else { return nil }
  return CGWindowID(number)
}

func point(from params: Params) throws -> CGPoint {
  let requested = CGPoint(x: try params.double("x"), y: try params.double("y"))
  return Geometry.clampToWorkspace(requested)
}

func windowId(from params: Params) throws -> CGWindowID {
  guard let number = UInt32(try params.string("windowId")) else {
    throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
  }
  return CGWindowID(number)
}

/// An optional window-id filter: absent means "every window".
func windowIdSet(from params: Params, key: String) -> Set<CGWindowID>? {
  guard let raw = params.raw[key] as? [Any] else { return nil }
  let ids = raw.compactMap { entry -> CGWindowID? in
    if let text = entry as? String, let number = UInt32(text) { return CGWindowID(number) }
    if let number = entry as? NSNumber { return CGWindowID(number.uint32Value) }
    return nil
  }
  return Set(ids)
}

func intArray(_ params: Params, _ key: String) -> [Int] {
  (params.raw[key] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? []
}

func launchApp(app: String, arguments: [String]) throws -> [String: Any] {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  // `-a` opens by application name or path; anything after `--args` is passed to
  // the launched app. `open` returns as soon as the launch is handed off.
  var args = ["-a", app]
  if !arguments.isEmpty {
    args.append("--args")
    args.append(contentsOf: arguments)
  }
  process.arguments = args
  do {
    try process.run()
  } catch {
    throw RPCError(.internalError, "could not launch \(app): \(error.localizedDescription)")
  }
  process.waitUntilExit()
  guard process.terminationStatus == 0 else {
    throw RPCError(.targetMissing, "no application named \(app) could be opened")
  }
  return ["resolvedCommand": "open -a \(app)"]
}

/// Bring a window forward *without* activating its application.
///
/// This deliberately has no activation fallback. It used to end with
/// `NSRunningApplication.activate()` when AXRaise left the window short of
/// frontmost — which is almost always, for a window in a background app — so the
/// Node side's "raise the target before clicking it" step pulled the human's
/// frontmost application out from under them on essentially every click. That is
/// the exact disruption this whole helper exists to avoid.
///
/// When the window cannot be brought forward this reports `notDelivered` rather
/// than forcing it. The caller then checks whether the target is actually
/// occluded and refuses only if it is: a covered target is worth refusing, but a
/// merely-not-frontmost one is fine, because input is posted to the window by id
/// and reaches it whatever is stacked above.
func raiseWindow(windowId: CGWindowID) throws {
  guard let window = Windows.window(withNumber: windowId) else {
    throw RPCError(.targetMissing, "no window has id \(windowId)")
  }
  // The Node side raises the window the agent named right before typing into
  // it, so the keys must go there whatever the last pointer gesture aimed at.
  input.setKeyboardTarget(window)
  // AXRaise brings the window to the front of its own application without
  // activating that application, which is as far as this is willing to go.
  guard Accessibility.raise(window) else {
    throw RPCError(
      .notDelivered, "window \(windowId) could not be raised without activating its application")
  }
  // WindowServer restacks asynchronously; give it a beat before believing the
  // window list.
  usleep(20_000)
  Windows.invalidate()
  if Windows.fresh().first(where: { $0.onScreen })?.windowNumber == windowId { return }
  throw RPCError(
    .notDelivered, "window \(windowId) is raised within its app but is not frontmost")
}

// MARK: - Shutdown

/// Never leave a button or a modifier latched for the human: whatever the reason
/// this process is going away, the matching up events go out first.
func shutdown(_ code: Int32) -> Never {
  input.unwind()
  exit(code)
}

// MARK: - stdin loop

func handleLine(_ line: Data) {
  guard !line.isEmpty else { return }
  let parsed: Any
  do {
    parsed = try JSONSerialization.jsonObject(with: line)
  } catch {
    writeError(
      id: NSNull(), code: .parseError, message: "invalid JSON: \(error.localizedDescription)")
    return
  }
  guard let object = parsed as? [String: Any] else {
    writeError(id: NSNull(), code: .invalidRequest, message: "request must be a JSON object")
    return
  }
  let id = object["id"]
  guard let method = object["method"] as? String else {
    writeError(id: id, code: .invalidRequest, message: "request is missing 'method'")
    return
  }
  let params = Params(raw: object["params"] as? [String: Any] ?? [:])
  // Parsing happens on the reader thread; the work itself goes to the lane that
  // owns this method so a capture never queues behind a click, or vice versa.
  Lanes.queue(for: method).async {
    do {
      let result = try handle(method: method, params: params)
      writeResult(id: id, result: result)
    } catch let error as RPCError {
      writeError(id: id, code: error.code, message: error.message)
    } catch {
      writeError(id: id, code: .internalError, message: error.localizedDescription)
    }
  }
}

Lanes.reader.async {
  let stdin = FileHandle.standardInput
  var buffer = Data()
  while true {
    let chunk = stdin.availableData
    if chunk.isEmpty { break }  // stdin closed: the server is shutting down.
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0a) {
      let line = buffer.subdata(in: buffer.startIndex..<newline)
      buffer.removeSubrange(buffer.startIndex...newline)
      handleLine(line)
    }
  }
  shutdown(0)
}

var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler { shutdown(0) }
  source.resume()
  signalSources.append(source)
}

writeNotification(method: "ready", params: ["protocolVersion": 1])

// AppKit main loop drives the overlay window; RPC runs on the lane queues.
app.run()
