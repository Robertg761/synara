// Window enumeration via CGWindowList.
//
// The on-screen window list is the macOS analog of the KWin plugin's window
// document: id, title, owning app + pid, global bounds, and a stacking order.
// CGWindowListCopyWindowInfo already returns windows front-to-back, which gives
// a stacking index for free and lets the input path resolve which window a bare
// coordinate would hit.

import AppKit
import CoreGraphics

struct DesktopWindow {
  let windowNumber: CGWindowID
  let ownerPID: pid_t
  let title: String
  let appName: String
  let bounds: CGRect
  let stackingIndex: Int
  let onScreen: Bool
  let minimized: Bool
  let layer: Int
}

enum Windows {
  /// The current on-screen window list, front-to-back, filtered to real
  /// application windows (normal window layer, non-zero size). Menus, the Dock,
  /// and the wallpaper are dropped: an agent drives application windows, and a
  /// desktop-layer surface is exactly the "click landed on wallpaper" trap the
  /// Linux runs hit.
  static func list() -> [DesktopWindow] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard
      let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
    else { return [] }

    var windows: [DesktopWindow] = []
    var index = 0
    for entry in info {
      guard
        let number = entry[kCGWindowNumber as String] as? NSNumber,
        let ownerPID = entry[kCGWindowOwnerPID as String] as? NSNumber,
        let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
        let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
      else { continue }

      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      // Layer 0 is the normal application-window layer. Anything above is a
      // panel/menu/overlay the agent must not treat as a target window.
      if layer != 0 { continue }
      if bounds.width < 1 || bounds.height < 1 { continue }

      let title = (entry[kCGWindowName as String] as? String) ?? ""
      let appName = (entry[kCGWindowOwnerName as String] as? String) ?? ""
      let onScreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true

      windows.append(
        DesktopWindow(
          windowNumber: CGWindowID(number.uint32Value),
          ownerPID: pid_t(ownerPID.int32Value),
          title: title,
          appName: appName,
          bounds: bounds,
          stackingIndex: index,
          onScreen: onScreen,
          minimized: !onScreen,
          layer: layer))
      index += 1
    }
    return windows
  }

  /// The window whose id matches, if any.
  static func window(withNumber number: CGWindowID) -> DesktopWindow? {
    list().first { $0.windowNumber == number }
  }

  /// The topmost window whose bounds contain `point` — what an unscoped click at
  /// that global point would be delivered to.
  static func topmost(at point: CGPoint) -> DesktopWindow? {
    // `list()` is front-to-back, so the first hit is the topmost.
    list().first { $0.onScreen && $0.bounds.contains(point) }
  }

  /// Ids of the windows above `window` that overlap its bounds, so the backend
  /// can warn that a coordinate click would land elsewhere.
  static func occluders(of window: DesktopWindow, in all: [DesktopWindow]) -> [String] {
    all
      .filter {
        $0.windowNumber != window.windowNumber
          && $0.stackingIndex < window.stackingIndex
          && $0.bounds.intersects(window.bounds)
      }
      .map { String($0.windowNumber) }
  }

  static func dictionary(_ window: DesktopWindow, occluders: [String]) -> [String: Any] {
    var payload: [String: Any] = [
      "id": String(window.windowNumber),
      "title": window.title,
      "appName": window.appName,
      "pid": Int(window.ownerPID),
      "bounds": Geometry.rectDictionary(window.bounds),
      "focused": false,
      "minimized": window.minimized,
      "visible": window.onScreen,
      "stackingIndex": window.stackingIndex,
    ]
    if !occluders.isEmpty {
      payload["occludedBy"] = occluders
    }
    return payload
  }
}
