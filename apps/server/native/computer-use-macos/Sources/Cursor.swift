// The "Software Cursor" overlay — a picture, not a pointer.
//
// macOS runs exactly one real cursor and the agent never moves it. Following
// Codex's confirmed configuration, this is a borderless, click-through NSWindow
// the helper draws wherever the agent is about to act, so the human can watch
// without the two fighting over the pointer. A name badge fades in beside it so
// multiple agents are distinguishable from day one (Codex shipped without this
// and immediately got a bug filed).
//
// The window is `ignoresMouseEvents` (the human's real clicks pass through) and
// `sharingType = .readOnly` (so the agent's own screenshots can include it while
// staying out of the human's way). All AppKit mutation happens on the main
// thread; callers may invoke `move`/`setName` from any queue.

import AppKit
import CoreGraphics

final class AgentCursor {
  private var window: NSWindow?
  private var badgeLabel: NSTextField?
  private let size = CGFloat(24)
  private let primaryHeight: CGFloat

  init() {
    self.primaryHeight = NSScreen.screens.first?.frame.height ?? 0
  }

  /// Build the overlay window. Must run on the main thread.
  func install() {
    let frame = NSRect(x: 0, y: 0, width: 160, height: 40)
    let window = NSWindow(
      contentRect: frame,
      styleMask: [.borderless],
      backing: .buffered,
      defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.sharingType = .readOnly
    window.level = .normal
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

    let container = NSView(frame: frame)
    container.wantsLayer = true

    // A simple arrow drawn at runtime rather than a shipped asset, matching the
    // reference's Core Animation cursor.
    let arrow = CAShapeLayer()
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 4, y: frame.height - 4))
    path.addLine(to: CGPoint(x: 4, y: frame.height - 4 - size))
    path.addLine(to: CGPoint(x: 4 + size * 0.28, y: frame.height - 4 - size * 0.72))
    path.addLine(to: CGPoint(x: 4 + size * 0.5, y: frame.height - 4 - size * 0.5))
    path.closeSubpath()
    arrow.path = path
    arrow.fillColor = NSColor.systemBlue.cgColor
    arrow.strokeColor = NSColor.white.cgColor
    arrow.lineWidth = 1.5
    container.layer?.addSublayer(arrow)

    let badge = NSTextField(labelWithString: "")
    badge.frame = NSRect(x: 4 + size * 0.6, y: frame.height - 4 - size, width: 130, height: 18)
    badge.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    badge.textColor = .white
    badge.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.85)
    badge.drawsBackground = true
    badge.isBezeled = false
    badge.isEditable = false
    badge.alignment = .center
    badge.isHidden = true
    container.addSubview(badge)

    window.contentView = container
    window.orderFrontRegardless()
    self.window = window
    self.badgeLabel = badge
  }

  func move(to global: CGPoint) {
    onMain {
      guard let window = self.window else { return }
      // Global top-left → AppKit bottom-left; the arrow tip sits at the point.
      let originY = self.primaryHeight - global.y - window.frame.height
      window.setFrameOrigin(NSPoint(x: global.x - 4, y: originY))
      window.orderFrontRegardless()
    }
  }

  func setName(_ name: String) {
    onMain {
      guard let badge = self.badgeLabel else { return }
      badge.stringValue = name
      badge.isHidden = name.isEmpty
    }
  }

  private func onMain(_ body: @escaping () -> Void) {
    if Thread.isMainThread {
      body()
    } else {
      DispatchQueue.main.async(execute: body)
    }
  }
}
