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

import ApplicationServices
import CoreGraphics
import Foundation

enum Accessibility {
  /// Whether this process is a trusted Accessibility client right now.
  static func isTrusted() -> Bool {
    AXIsProcessTrusted()
  }

  /// The desktop AX forest: one child per on-screen window, shifted to nothing
  /// (already global). Depth-capped so a runaway hierarchy cannot produce an
  /// unbounded response.
  static func describeDesktop(maxDepth: Int) throws -> [String: Any] {
    guard isTrusted() else {
      throw RPCError(.permissionDenied, "Accessibility is not granted to this app")
    }
    let windows = Windows.list()
    var children: [[String: Any]] = []
    // One AX application element per distinct owning pid, reused across its
    // windows. AXManualAccessibility is poked on each so Chromium/Electron
    // targets expose a tree at all.
    var appElements: [pid_t: AXUIElement] = [:]
    for window in windows {
      let app =
        appElements[window.ownerPID]
        ?? {
          let element = AXUIElementCreateApplication(window.ownerPID)
          pokeManualAccessibility(element)
          appElements[window.ownerPID] = element
          return element
        }()
      guard let axWindow = matchWindow(app: app, to: window) else { continue }
      if var windowNode = node(
        from: axWindow, windowId: window.windowNumber, depth: 0, maxDepth: maxDepth)
      {
        // Stamp the absolute child-index route from this window's root, once,
        // after the whole subtree is built.
        let kids = (windowNode["children"] as? [[String: Any]]) ?? []
        windowNode["children"] = attachNodePaths(kids, prefix: [])
        children.append(windowNode)
      }
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
    let app = AXUIElementCreateApplication(window.ownerPID)
    pokeManualAccessibility(app)
    guard let axWindow = matchWindow(app: app, to: window) else {
      throw RPCError(.targetMissing, "no accessibility window matched id \(windowId)")
    }
    var current = axWindow
    for index in path {
      let kids = childElements(of: current)
      guard index >= 0, index < kids.count else {
        throw RPCError(.targetMissing, "node path left the tree at index \(index)")
      }
      current = kids[index]
    }
    return current
  }

  /// Pick the AX window that matches a `CGWindow`. Title first (unique in
  /// practice), then the closest frame overlap, because a titleless window still
  /// has to be addressable.
  private static func matchWindow(app: AXUIElement, to window: DesktopWindow) -> AXUIElement? {
    let axWindows = attributeElements(app, kAXWindowsAttribute)
    if axWindows.isEmpty { return nil }
    if !window.title.isEmpty {
      for candidate in axWindows where stringAttribute(candidate, kAXTitleAttribute) == window.title {
        return candidate
      }
    }
    var best: AXUIElement?
    var bestArea: CGFloat = -1
    for candidate in axWindows {
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

  private static func node(
    from element: AXUIElement, windowId: CGWindowID, depth: Int, maxDepth: Int
  ) -> [String: Any]? {
    let frame = frame(of: element) ?? .zero
    let role = stringAttribute(element, kAXRoleAttribute) ?? "AXUnknown"
    let label =
      stringAttribute(element, kAXTitleAttribute) ?? stringAttribute(element, kAXDescriptionAttribute)
    let value = stringAttribute(element, kAXValueAttribute)
    let description = stringAttribute(element, kAXDescriptionAttribute)
    let editable = isSettable(element, kAXValueAttribute)

    var children: [[String: Any]] = []
    if depth < maxDepth {
      let kids = childElements(of: element)
      for (index, child) in kids.enumerated() {
        // The child's own path is this node's path plus its index; the Node side
        // rebuilds the full path from the window root by descent order, so each
        // node carries the index route implicitly through nesting. We publish
        // the explicit path too for a direct re-resolve.
        if var childNode = node(from: child, windowId: windowId, depth: depth + 1, maxDepth: maxDepth)
        {
          childNode["_index"] = index
          children.append(childNode)
        }
      }
    }

    return [
      "role": role,
      "label": label as Any? ?? NSNull(),
      "value": value as Any? ?? NSNull(),
      "description": description as Any? ?? NSNull(),
      "frame": Geometry.rectDictionary(frame),
      "activationPoint": [
        "x": Double(frame.midX),
        "y": Double(frame.midY),
      ],
      "onScreen": true,
      "windowId": String(windowId),
      "editable": editable,
      // Children keep their local `_index`; the window root stamps the absolute
      // `nodePath` in one pass so a semantic write can re-resolve each control.
      "children": children,
    ]
  }

  /// Walk the emitted children and stamp each with its absolute `nodePath`.
  private static func attachNodePaths(_ nodes: [[String: Any]], prefix: [Int]) -> [[String: Any]] {
    nodes.map { node in
      var copy = node
      let index = (node["_index"] as? Int) ?? 0
      let path = prefix + [index]
      copy["nodePath"] = path
      copy.removeValue(forKey: "_index")
      if let kids = node["children"] as? [[String: Any]] {
        copy["children"] = attachNodePaths(kids, prefix: path)
      }
      return copy
    }
  }

  private static func pokeManualAccessibility(_ app: AXUIElement) {
    // Chromium/Electron expose no AX tree until asked; harmless elsewhere.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  }

  private static func childElements(of element: AXUIElement) -> [AXUIElement] {
    attributeElements(element, kAXChildrenAttribute)
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
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
  }

  private static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
    else { return false }
    return settable.boolValue
  }

  private static func frame(of element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        == .success,
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success
    else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    // swiftlint:disable:next force_cast
    let positionAX = positionValue as! AXValue
    // swiftlint:disable:next force_cast
    let sizeAX = sizeValue as! AXValue
    guard AXValueGetValue(positionAX, .cgPoint, &point),
      AXValueGetValue(sizeAX, .cgSize, &size)
    else { return nil }
    return CGRect(origin: point, size: size)
  }
}
