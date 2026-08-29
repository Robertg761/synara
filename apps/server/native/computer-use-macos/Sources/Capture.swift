// Screen capture.
//
// The reference design's capture chain is ScreenCaptureKit → `screencapture`
// CLI → error. This helper implements the reliable middle link directly:
// `/usr/sbin/screencapture` writing a PNG, which needs the same Screen Recording
// grant SCK does, never hangs the way `SCShareableContent` can (radar
// FB12114396), and returns pixels in the global top-left space the rest of the
// helper speaks. ScreenCaptureKit is the eventual upgrade for per-window
// off-screen capture and live frames; the still-PNG path is what Tier-1 parity
// with the KWin backend actually needs, since that backend also serves the pane
// as periodic full-workspace stills.
//
// The captured image is downscaled to the caller's `maxDimension` budget here,
// so the token cost of an observation is bounded at the source rather than after
// it has crossed the wire.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Capture {
  struct Result {
    let pngBase64: String
    let region: CGRect
  }

  /// Capture one desktop rect, in global top-left points.
  static func region(_ rect: CGRect, maxDimension: Int) throws -> Result {
    let args = [
      "-x",  // no capture sound
      "-o",  // no window shadow
      "-t", "png",
      "-R",
      "\(Int(rect.origin.x)),\(Int(rect.origin.y)),\(Int(rect.width)),\(Int(rect.height))",
    ]
    let png = try runScreencapture(extraArgs: args)
    return Result(pngBase64: try encode(png, maxDimension: maxDimension), region: rect)
  }

  /// Capture one window by its `CGWindowID`. The returned region is the window's
  /// current global bounds, which is the rect these pixels cover.
  static func window(_ number: CGWindowID, maxDimension: Int) throws -> Result {
    guard let target = Windows.window(withNumber: number) else {
      throw RPCError(.targetMissing, "no window has id \(number)")
    }
    let args = ["-x", "-o", "-t", "png", "-l", String(number)]
    let png = try runScreencapture(extraArgs: args)
    return Result(
      pngBase64: try encode(png, maxDimension: maxDimension), region: target.bounds)
  }

  // MARK: - Internals

  private static func runScreencapture(extraArgs: [String]) throws -> Data {
    let directory = FileManager.default.temporaryDirectory
    let file = directory.appendingPathComponent("synara-capture-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: file) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = extraArgs + [file.path]
    let errorPipe = Pipe()
    process.standardError = errorPipe
    do {
      try process.run()
    } catch {
      throw RPCError(.internalError, "screencapture could not start: \(error.localizedDescription)")
    }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let detail = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
      // A non-zero exit here is overwhelmingly a missing Screen Recording grant.
      throw RPCError(
        .permissionDenied,
        "screencapture failed (\(process.terminationStatus)); grant Screen Recording to this app"
          + (detail.map { $0.isEmpty ? "" : ": \($0)" } ?? ""))
    }
    guard let data = try? Data(contentsOf: file), !data.isEmpty else {
      throw RPCError(.permissionDenied, "screencapture produced no image; is Screen Recording granted?")
    }
    return data
  }

  /// Downscale so the longest side is at most `maxDimension`, then PNG-encode.
  /// A capture already within budget is returned untouched.
  private static func encode(_ png: Data, maxDimension: Int) throws -> String {
    guard maxDimension > 0,
      let source = CGImageSourceCreateWithData(png as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      // If it cannot be decoded here it is still a PNG the caller can decode;
      // ship it as-is rather than failing the whole capture.
      return png.base64EncodedString()
    }
    let longest = max(image.width, image.height)
    if longest <= maxDimension {
      return png.base64EncodedString()
    }
    let scale = CGFloat(maxDimension) / CGFloat(longest)
    let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
    guard
      let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
      return png.base64EncodedString()
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage() else {
      return png.base64EncodedString()
    }
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        output, UTType.png.identifier as CFString, 1, nil)
    else {
      return png.base64EncodedString()
    }
    CGImageDestinationAddImage(destination, scaled, nil)
    guard CGImageDestinationFinalize(destination) else {
      return png.base64EncodedString()
    }
    return (output as Data).base64EncodedString()
  }
}
