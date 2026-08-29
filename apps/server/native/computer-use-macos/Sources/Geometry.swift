// Coordinate-space helpers.
//
// One rule runs through the whole helper: every coordinate on the wire — window
// bounds, AX frames, capture regions, pointer targets — is in **global top-left
// screen space**, in logical points. `CGWindowList`, `AXUIElement`, and
// `CGEvent` already share that space, so an AX-derived target feeds a synthetic
// click with no conversion. AppKit (`NSScreen`, `NSWindow`) is the one subsystem
// with a bottom-left origin, so anything that touches AppKit converts here and
// nowhere else.

import AppKit
import CoreGraphics

enum Geometry {
  /// The union of every screen's frame, in global top-left points — the
  /// workspace the Node backend translates into its 0-based agent space.
  static func workspaceRect() -> CGRect {
    let screens = NSScreen.screens
    guard let primary = screens.first else {
      return CGRect(x: 0, y: 0, width: 1, height: 1)
    }
    // AppKit's global space is bottom-left with the primary screen's origin at
    // (0,0); flip into the top-left space CGWindow/CGEvent use. The primary
    // screen height is the flip axis for every other screen too.
    let primaryHeight = primary.frame.height
    var union = flipToTopLeft(primary.frame, primaryHeight: primaryHeight)
    for screen in screens.dropFirst() {
      union = union.union(flipToTopLeft(screen.frame, primaryHeight: primaryHeight))
    }
    return union
  }

  /// The backing scale factor of the screen that most contains `rect`.
  static func scaleFactor(for rect: CGRect) -> CGFloat {
    let primaryHeight = NSScreen.screens.first?.frame.height ?? rect.height
    var best: CGFloat = 1
    var bestArea: CGFloat = -1
    for screen in NSScreen.screens {
      let frame = flipToTopLeft(screen.frame, primaryHeight: primaryHeight)
      let overlap = frame.intersection(rect)
      let area = overlap.isNull ? 0 : overlap.width * overlap.height
      if area > bestArea {
        bestArea = area
        best = screen.backingScaleFactor
      }
    }
    return best
  }

  /// Convert one AppKit (bottom-left) rect into global top-left points.
  static func flipToTopLeft(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(
      x: rect.origin.x,
      y: primaryHeight - rect.origin.y - rect.height,
      width: rect.width,
      height: rect.height)
  }

  static func rectDictionary(_ rect: CGRect) -> [String: Any] {
    [
      "x": Double(rect.origin.x),
      "y": Double(rect.origin.y),
      "width": Double(rect.width),
      "height": Double(rect.height),
    ]
  }
}
