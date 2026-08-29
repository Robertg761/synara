// synara-computer-helper — the native side of Synara's macOS computer use.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio (one object per line),
// the same wire the device helper and Codex app-server speak, so the Node side
// reuses `@synara/shared/jsonrpc-stdio`. There is no frame socket: Tier-1
// capture is a whole-desktop PNG still that the Node backend publishes on a
// timer, exactly as the KWin backend does.
//
// Every coordinate on the wire is global top-left screen points. See
// Geometry.swift, and docs/computer-use-macos-reference.md for the mechanism.

import AppKit
import Foundation

let arguments = CommandLine.arguments

// `--probe`: report capabilities and exit. The build and the settings checklist
// read this; it never starts the server or the overlay.
if arguments.contains("--probe") {
  var payload = Capability.report()
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
    let windows = Windows.list()
    let payload = windows.map { window in
      Windows.dictionary(window, occluders: Windows.occluders(of: window, in: windows))
    }
    return [
      "windows": payload,
      "workspace": Geometry.rectDictionary(Geometry.workspaceRect()),
      // The frontmost on-screen application window is the focus target.
      "focusedWindowId": windows.first.map { String($0.windowNumber) } as Any? ?? NSNull(),
    ]

  case "screen-size":
    let rect = Geometry.workspaceRect()
    var payload = Geometry.rectDictionary(rect)
    payload["scale"] = Double(Geometry.scaleFactor(for: rect))
    return payload

  case "describe-ui":
    return try Accessibility.describeDesktop(maxDepth: params.optionalInt("maxDepth", default: 40))

  case "capture":
    let maxDimension = params.optionalInt("maxDimension", default: 2048)
    let kind = try params.string("kind")
    let result: Capture.Result
    switch kind {
    case "window":
      let windowId = try params.string("windowId")
      guard let number = UInt32(windowId) else {
        throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
      }
      result = try Capture.window(CGWindowID(number), maxDimension: maxDimension)
    case "region":
      guard let rect = params.rect("region") else {
        throw RPCError(.invalidParams, "region capture needs a {x,y,width,height} rect")
      }
      result = try Capture.region(rect, maxDimension: maxDimension)
    default:
      throw RPCError(.invalidParams, "capture kind must be 'window' or 'region'")
    }
    return ["base64": result.pngBase64, "region": Geometry.rectDictionary(result.region)]

  case "launch-app":
    return try launchApp(app: try params.string("app"), arguments: params.stringArray("arguments"))

  case "move":
    let point = try point(from: params)
    input.move(to: point)
    return ["x": Double(point.x), "y": Double(point.y)]

  case "click":
    let point = try point(from: params)
    try input.click(at: point)
    return ["x": Double(point.x), "y": Double(point.y)]

  case "double-click":
    let point = try point(from: params)
    try input.click(at: point, count: 2)
    return ["x": Double(point.x), "y": Double(point.y)]

  case "right-click":
    let point = try point(from: params)
    try input.rightClick(at: point)
    return ["x": Double(point.x), "y": Double(point.y)]

  case "drag":
    let from = CGPoint(x: try params.double("fromX"), y: try params.double("fromY"))
    let to = CGPoint(x: try params.double("toX"), y: try params.double("toY"))
    try input.drag(from: from, to: to, durationMs: params.optionalInt("durationMs", default: 220))
    return ["ok": true]

  case "scroll":
    let x = params.optionalDouble("x")
    let y = params.optionalDouble("y")
    let point = (x != nil && y != nil) ? CGPoint(x: x!, y: y!) : nil
    try input.scroll(at: point, deltaX: try params.double("deltaX"), deltaY: try params.double("deltaY"))
    return ["ok": true]

  case "type":
    try input.typeText(try params.string("text"))
    return ["ok": true]

  case "press-key":
    try input.pressKey(try params.string("key"), modifiers: params.stringArray("modifiers"))
    return ["ok": true]

  case "hotkey":
    let keys = params.stringArray("keys")
    guard !keys.isEmpty else { throw RPCError(.invalidParams, "hotkey needs a non-empty keys array") }
    try input.hotkey(keys)
    return ["ok": true]

  case "set-value":
    let windowId = try windowId(from: params)
    try Accessibility.setValue(
      windowId: windowId, path: intArray(params, "nodePath"), value: try params.string("value"))
    return ["ok": true]

  case "perform-action":
    let windowId = try windowId(from: params)
    try Accessibility.performAction(
      windowId: windowId, path: intArray(params, "nodePath"), action: try params.string("action"))
    return ["ok": true]

  case "raise-window":
    try raiseWindow(windowId: try windowId(from: params))
    return ["ok": true]

  case "read-clipboard":
    return ["text": NSPasteboard.general.string(forType: .string) ?? ""]

  case "write-clipboard":
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(try params.string("text"), forType: .string)
    return ["ok": true]

  case "set-agent-cursor":
    cursor.setName(params.optionalString("name") ?? "")
    return ["ok": true]

  default:
    throw RPCError(.methodNotFound, "unknown method '\(method)'")
  }
}

// MARK: - Method helpers

func point(from params: Params) throws -> CGPoint {
  CGPoint(x: try params.double("x"), y: try params.double("y"))
}

func windowId(from params: Params) throws -> CGWindowID {
  guard let number = UInt32(try params.string("windowId")) else {
    throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
  }
  return CGWindowID(number)
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

func raiseWindow(windowId: CGWindowID) throws {
  guard let window = Windows.window(withNumber: windowId) else {
    throw RPCError(.targetMissing, "no window has id \(windowId)")
  }
  // Activating the owning app raises its windows without moving the human's
  // keyboard focus target for the agent's own input, which is targeted per-post.
  if let running = NSRunningApplication(processIdentifier: window.ownerPID) {
    running.activate(options: [])
  }
}

// MARK: - stdin loop

let requestQueue = DispatchQueue(label: "dev.synara.computer-helper.rpc")

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
  do {
    let result = try handle(method: method, params: params)
    writeResult(id: id, result: result)
  } catch let error as RPCError {
    writeError(id: id, code: error.code, message: error.message)
  } catch {
    writeError(id: id, code: .internalError, message: error.localizedDescription)
  }
}

requestQueue.async {
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
  exit(0)
}

var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler { exit(0) }
  source.resume()
  signalSources.append(source)
}

writeNotification(method: "ready", params: ["protocolVersion": 1])

// AppKit main loop drives the overlay window; RPC runs on the background queue.
app.run()
