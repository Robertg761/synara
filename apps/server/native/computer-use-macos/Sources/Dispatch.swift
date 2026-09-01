// Request lanes.
//
// One serial queue for everything was the original shape, and it made the two
// halves of the helper fight each other: the pane's still-frame capture runs
// every 500 ms for as long as the computer pane is open, so with a single queue
// every click and keystroke queued behind a screenshot, and one slow AX walk
// stalled every capture behind it. The protocol correlates by request id and
// `writeMessage` is locked, so responses are free to complete out of order —
// the only ordering that has to hold is *within* a lane.
//
//   * **input** — one serial queue, arrival order. Clicks, keys, drags, and the
//     clipboard are a sequence the agent expects to happen in the order it asked
//     for, and they mutate shared state (the keyboard target, the held-button
//     bookkeeping) that is only safe because it has exactly one writer.
//   * **perception** — concurrent. Captures, window lists, and pings are pure
//     reads; a `ping` must answer while a capture is in flight, which is exactly
//     what the watchdog on the Node side is measuring.
//   * **accessibility** — its own serial queue. An AX walk is synchronous IPC
//     into other processes and can take hundreds of milliseconds even bounded;
//     the reference is explicit that it belongs off the capture path, and
//     serialising it keeps one runaway app from multiplying into several
//     blocked threads.
//
// stdin stays on its own reader thread: it only parses and hands off, so a busy
// lane never stops the helper from noticing the next request or a closed pipe.

import Dispatch

enum Lanes {
  /// Actions, in the order the agent asked for them.
  static let input = DispatchQueue(
    label: "dev.synara.computer-helper.input", qos: .userInitiated)
  /// Reads, concurrently.
  static let perception = DispatchQueue(
    label: "dev.synara.computer-helper.perception", qos: .userInitiated, attributes: .concurrent)
  /// The AX walk, alone.
  static let accessibility = DispatchQueue(
    label: "dev.synara.computer-helper.accessibility", qos: .userInitiated)
  /// The stdin reader.
  static let reader = DispatchQueue(
    label: "dev.synara.computer-helper.stdin", qos: .userInitiated)

  /// Which lane a method runs on. An unknown method takes the perception lane:
  /// it only produces a "method not found" error and must not sit behind input.
  static func queue(for method: String) -> DispatchQueue {
    switch method {
    case "move", "click", "double-click", "right-click", "drag", "scroll", "type", "press-key",
      "hotkey", "set-value", "perform-action", "focus-window", "raise-window", "read-clipboard",
      "write-clipboard",
      "set-agent-cursor", "launch-app":
      // `launch-app` is an action with the same ordering expectation as the
      // rest: "open the app, then click in it" has to happen in that order.
      return input
    case "describe-ui":
      return accessibility
    default:
      return perception
    }
  }
}
