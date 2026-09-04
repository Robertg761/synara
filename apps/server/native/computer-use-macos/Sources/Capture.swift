// Screen capture.
//
// The chain is ScreenCaptureKit → `screencapture` CLI → error, exactly as the
// design reference specifies (§4.3), and the result reports which link served it
// so the backend can track the fallback rate as a health metric.
//
// **ScreenCaptureKit (macOS 14+, primary).** `SCScreenshotManager.captureImage`
// composites in WindowServer and hands back a `CGImage` with no temp file, no
// subprocess, and no second decode. The whole budget is applied at the source:
// `SCStreamConfiguration.width/height` carries the caller's `maxDimension` so
// WindowServer does the downscale, and `sourceRect` carries the requested region
// so only those pixels are ever composited. One ImageIO PNG encode follows and
// that is the entire pipeline.
//
// **`screencapture` (fallback).** Needs the same Screen Recording grant, never
// hangs the way `SCShareableContent` can (radar FB12114396), and composites
// across displays — which is why a region spanning two displays takes this path
// rather than the SCK one, whose filters are per-display. Also the path on
// macOS 12.3–13.x, where `SCScreenshotManager` does not exist.
//
// Reliability rules from the reference, all here: a warm `SCShareableContent`
// cache (~2 s TTL) so the hot path skips the call that can hang; a single-flight
// gate so a hung call can never leak more than the one thread already inside it
// (the permit is released by the completion handler, never by a timed-out
// waiter, so every later caller fails fast to the fallback instead of piling
// up); and a 3 s deadline on every SCK call.
//
// The `region` in the result is always the rect these pixels actually cover, in
// global top-left points — clipped to the display when the request ran off it —
// because the Node side derives the screenshot scale from PNG pixel size over
// region point size (`screenshotFromPng`). Downscaling therefore has to keep the
// pixel dimensions proportional to the region, which is what the width/height
// computation below guarantees.

import CoreGraphics
import CoreVideo
import Dispatch
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
  /// Which link of the chain produced an image.
  enum Source: String {
    case screenCaptureKit = "screencapturekit"
    case screencapture = "screencapture"
  }

  struct Result {
    let pngBase64: String
    let region: CGRect
    let source: Source
  }

  /// Capture one desktop rect, in global top-left points.
  ///
  /// The rect is clipped to the desktop before anything else happens. Both links
  /// of the chain need that: ScreenCaptureKit rejects a `sourceRect` that misses
  /// its display and falls through, and the `screencapture` arguments below are
  /// integers — `Int(1e30)` is a trapping conversion, so a region far off the
  /// desktop used to abort the helper outright and take every other in-flight
  /// action with it.
  static func region(_ requested: CGRect, maxDimension: Int, prefer: Source?) throws -> Result {
    let rect = try Geometry.clampRectToWorkspace(requested)
    if prefer != .screencapture, #available(macOS 14.0, *) {
      if let capture = captureRegionWithSCK(rect, maxDimension: maxDimension) {
        return Result(
          pngBase64: capture.png.base64EncodedString(),
          region: capture.region,
          source: .screenCaptureKit)
      }
    }
    let origin = (x: Geometry.clampToInt32(rect.origin.x), y: Geometry.clampToInt32(rect.origin.y))
    let size = (
      width: Geometry.clampToInt32(rect.width), height: Geometry.clampToInt32(rect.height)
    )
    let args = [
      "-x",  // no capture sound
      "-o",  // no window shadow
      "-t", "png",
      "-R",
      "\(origin.x),\(origin.y),\(size.width),\(size.height)",
    ]
    let png = try runScreencapture(extraArgs: args)
    return Result(
      pngBase64: try downscaleAndEncode(png, maxDimension: maxDimension),
      // `screencapture -R` honours the origin but silently clips the extent to
      // what is actually on a display. Returning the *requested* rect made the
      // Node side derive the screenshot scale from a size the pixels never
      // covered, and every coordinate an agent read off that image then mapped
      // back to the wrong place on the desktop.
      region: coveredRect(requested: rect, png: png),
      source: .screencapture)
  }

  /// Capture one window by its `CGWindowID`. The returned region is the window's
  /// current global bounds, which is the rect these pixels cover.
  static func window(_ number: CGWindowID, maxDimension: Int, prefer: Source?) throws -> Result {
    guard let target = Windows.window(withNumber: number) else {
      throw RPCError(.targetMissing, "no window has id \(number)")
    }
    // A minimized or otherwise off-screen window has no composited pixels. Both
    // links of the chain answer anyway — with the desktop behind it, or with a
    // stale cached frame — and the reported region is then a rect the image
    // does not cover, so every coordinate the agent reads off it maps to the
    // wrong place. There is no honest image to return, so this refuses.
    guard target.onScreen else {
      throw RPCError(.targetMissing, "window \(number) is not on screen")
    }
    // A window whose bounds miss every display is the same trapping-conversion
    // hazard as a region, and equally has nothing to show.
    guard (try? Geometry.clampRectToWorkspace(target.bounds)) != nil else {
      throw RPCError(.targetMissing, "window \(number) is not on any display")
    }
    if prefer != .screencapture, #available(macOS 14.0, *) {
      if let capture = captureWindowWithSCK(number, maxDimension: maxDimension) {
        return Result(
          pngBase64: capture.png.base64EncodedString(), region: capture.frame,
          source: .screenCaptureKit)
      }
    }
    let args = ["-x", "-o", "-t", "png", "-l", String(number)]
    let png = try runScreencapture(extraArgs: args)
    return Result(
      pngBase64: try downscaleAndEncode(png, maxDimension: maxDimension),
      region: coveredRect(requested: target.bounds, png: png),
      source: .screencapture)
  }

  /// The rect a fallback capture's pixels actually cover, in global top-left
  /// points: the requested origin with the extent the PNG really has, recovered
  /// by dividing its pixel size by the display's backing scale. Falls back to
  /// the requested rect when the PNG cannot be measured, which is no worse than
  /// what it replaces.
  private static func coveredRect(requested: CGRect, png: Data) -> CGRect {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
      let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
      pixelWidth > 0, pixelHeight > 0
    else { return requested }
    let scale = Double(Geometry.scaleFactor(for: requested))
    guard scale > 0 else { return requested }
    return CGRect(
      x: requested.origin.x,
      y: requested.origin.y,
      width: pixelWidth / scale,
      height: pixelHeight / scale)
  }

  // MARK: - ScreenCaptureKit

  @available(macOS 14.0, *)
  private static func captureRegionWithSCK(_ rect: CGRect, maxDimension: Int)
    -> (png: Data, region: CGRect)?
  {
    guard rect.width >= 1, rect.height >= 1, let content = shareableContent() else { return nil }

    // Pick the display the request lands on. A rect that overlaps two displays
    // cannot be served by one `SCContentFilter`, so it takes the `screencapture`
    // fallback, which composites the global space; the common case is one
    // display, where the rect is simply clipped to it.
    var best: (display: SCDisplay, bounds: CGRect, overlap: CGFloat)?
    var overlappedDisplays = 0
    for display in content.displays {
      let bounds = CGDisplayBounds(display.displayID)
      let intersection = bounds.intersection(rect)
      guard !intersection.isNull, intersection.width >= 1, intersection.height >= 1 else { continue }
      overlappedDisplays += 1
      let area = intersection.width * intersection.height
      if area > (best?.overlap ?? -1) {
        best = (display, bounds, area)
      }
    }
    guard overlappedDisplays == 1, let chosen = best else { return nil }
    let clipped = chosen.bounds.intersection(rect).integral

    let filter = SCContentFilter(display: chosen.display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    // `sourceRect` is display-local points; everything else on the wire is global.
    configuration.sourceRect = CGRect(
      x: clipped.origin.x - chosen.bounds.origin.x,
      y: clipped.origin.y - chosen.bounds.origin.y,
      width: clipped.width,
      height: clipped.height)
    let size = outputPixelSize(
      points: clipped.size, scale: CGFloat(filter.pointPixelScale), maxDimension: maxDimension)
    configuration.width = size.width
    configuration.height = size.height
    apply(commonSettings: configuration)
    if #available(macOS 14.2, *) {
      configuration.ignoreShadowsDisplay = true
      configuration.ignoreGlobalClipDisplay = true
    }

    guard let image = captureImage(filter: filter, configuration: configuration),
      let png = pngData(image)
    else { return nil }
    return (png, clipped)
  }

  @available(macOS 14.0, *)
  private static func captureWindowWithSCK(_ number: CGWindowID, maxDimension: Int)
    -> (png: Data, frame: CGRect)?
  {
    guard var content = shareableContent() else { return nil }
    var match = content.windows.first { $0.windowID == number }
    if match == nil {
      // A window opened inside the cache TTL is not in the warm copy; one forced
      // refresh covers it, and anything still missing takes the fallback.
      invalidateShareableContent()
      guard let refreshed = shareableContent() else { return nil }
      content = refreshed
      match = content.windows.first { $0.windowID == number }
    }
    guard let scWindow = match else { return nil }

    let filter = SCContentFilter(desktopIndependentWindow: scWindow)
    let configuration = SCStreamConfiguration()
    let size = outputPixelSize(
      points: filter.contentRect.size,
      scale: CGFloat(filter.pointPixelScale),
      maxDimension: maxDimension)
    configuration.width = size.width
    configuration.height = size.height
    apply(commonSettings: configuration)
    if #available(macOS 14.2, *) {
      // Single-window equivalents of the CLI's `-o`: no drop shadow, and no clip
      // to the display, so an off-screen edge still comes back.
      configuration.ignoreShadowsSingleWindow = true
      configuration.ignoreGlobalClipSingleWindow = true
      configuration.includeChildWindows = false
    }

    guard let image = captureImage(filter: filter, configuration: configuration),
      let png = pngData(image)
    else { return nil }
    // The window's own frame, from the same `SCWindow` that produced these
    // pixels. Pairing them with `CGWindowList` bounds read separately meant the
    // region and the image could describe two different moments — and the Node
    // side derives the screenshot scale from pixels ÷ region, so a disagreement
    // there sends every coordinate the agent reads off this image to the wrong
    // place on the desktop.
    return (png, scWindow.frame)
  }

  @available(macOS 14.0, *)
  private static func apply(commonSettings configuration: SCStreamConfiguration) {
    configuration.capturesAudio = false
    // The human's real pointer is not part of the agent's observation; the agent
    // cursor is an ordinary `.readOnly` window and is composited like any other.
    configuration.showsCursor = false
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.colorSpaceName = CGColorSpace.sRGB
    configuration.scalesToFit = true
    configuration.queueDepth = 3
  }

  /// Pixel dimensions for `points` at `scale`, capped so the longest side fits
  /// `maxDimension`. Both sides are scaled by the same factor, which is what
  /// keeps `pixels / region points` a single meaningful scale on the Node side.
  private static func outputPixelSize(points: CGSize, scale: CGFloat, maxDimension: Int)
    -> (width: Int, height: Int)
  {
    let backing = scale > 0 ? scale : 1
    let fullWidth = points.width * backing
    let fullHeight = points.height * backing
    let longest = max(fullWidth, fullHeight)
    var factor: CGFloat = 1
    if maxDimension > 0, longest > CGFloat(maxDimension) {
      factor = CGFloat(maxDimension) / longest
    }
    return (
      max(1, Int((fullWidth * factor).rounded())),
      max(1, Int((fullHeight * factor).rounded()))
    )
  }

  /// One SCK screenshot under a 3 s deadline. A deadline miss is reported as a
  /// failure so the caller drops to the fallback rather than waiting on a call
  /// that may never return.
  @available(macOS 14.0, *)
  private static func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration)
    -> CGImage?
  {
    let box = Box<CGImage?>(nil)
    let done = DispatchSemaphore(value: 0)
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) {
      image, error in
      if let error {
        logDiagnostic("ScreenCaptureKit capture failed: \(error.localizedDescription)")
      }
      box.value = image
      done.signal()
    }
    guard done.wait(timeout: .now() + captureDeadlineSeconds) == .success else {
      logDiagnostic("ScreenCaptureKit capture exceeded its \(captureDeadlineSeconds)s deadline")
      return nil
    }
    return box.value
  }

  // MARK: - Shareable content (cached, single-flight, deadlined)

  private static let captureDeadlineSeconds: Double = 3
  private static let contentTTLNanoseconds: UInt64 = 2_000_000_000
  private static let contentLock = NSLock()
  private static var cachedContent: SCShareableContent?
  private static var cachedContentAt: UInt64 = 0
  /// At most one outstanding `SCShareableContent` request, ever. The permit is
  /// released by the completion handler, so a request that hangs (FB12114396)
  /// holds it until it returns and every other caller fails fast to the CLI
  /// fallback instead of adding another blocked thread.
  private static let contentGate = DispatchSemaphore(value: 1)

  private static func invalidateShareableContent() {
    contentLock.lock()
    cachedContent = nil
    contentLock.unlock()
  }

  private static func shareableContent() -> SCShareableContent? {
    let now = DispatchTime.now().uptimeNanoseconds
    contentLock.lock()
    let warm = cachedContent
    let fresh = warm != nil && now &- cachedContentAt <= contentTTLNanoseconds
    contentLock.unlock()
    if fresh { return warm }

    guard contentGate.wait(timeout: .now()) == .success else {
      // Another request is still outstanding. A slightly stale display/window
      // list is a far better answer than a second blocked thread; with no cache
      // at all the caller takes the fallback.
      return warm
    }

    let done = DispatchSemaphore(value: 0)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) {
      content, error in
      if let content {
        contentLock.lock()
        cachedContent = content
        cachedContentAt = DispatchTime.now().uptimeNanoseconds
        contentLock.unlock()
      } else if let error {
        logDiagnostic("SCShareableContent failed: \(error.localizedDescription)")
      }
      contentGate.signal()
      done.signal()
    }
    guard done.wait(timeout: .now() + captureDeadlineSeconds) == .success else {
      logDiagnostic("SCShareableContent exceeded its \(captureDeadlineSeconds)s deadline")
      return warm
    }
    contentLock.lock()
    let result = cachedContent
    contentLock.unlock()
    return result ?? warm
  }

  /// A mutable cell a completion handler can write into from another thread; the
  /// semaphore around it is the synchronisation, hence `@unchecked`.
  private final class Box<Value>: @unchecked Sendable {
    var value: Value
    init(_ value: Value) { self.value = value }
  }

  // MARK: - screencapture fallback

  private static func runScreencapture(extraArgs: [String]) throws -> Data {
    let directory = FileManager.default.temporaryDirectory
    let file = directory.appendingPathComponent("synara-capture-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: file) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = extraArgs + [file.path]
    let errorPipe = Pipe()
    process.standardError = errorPipe
    // The file header promises this path "never hangs the way SCShareableContent
    // can"; without a deadline that is only true of the OS's good behaviour, and
    // a wedged subprocess would hold the perception lane open indefinitely.
    //
    // Armed before `run()`: a process that exits between the launch and the
    // assignment never calls a handler installed afterwards, and the wait below
    // would then have burned the whole deadline on a subprocess that had
    // already finished.
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    do {
      try process.run()
    } catch {
      throw RPCError(.internalError, "screencapture could not start: \(error.localizedDescription)")
    }
    if finished.wait(timeout: .now() + captureDeadlineSeconds) == .timedOut {
      process.terminate()
      _ = finished.wait(timeout: .now() + 1)
      throw RPCError(
        .internalError, "screencapture exceeded its \(captureDeadlineSeconds)s deadline")
    }

    let detail =
      String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard process.terminationStatus == 0 else {
      // Only claim a permission problem when the grant really is missing.
      // Reporting every failure as -32000 made the backend latch
      // `captureGranted = false` on a transient error and blank the live pane
      // for the rest of the session.
      throw captureFailure(
        "screencapture failed (\(process.terminationStatus))",
        detail: detail)
    }
    guard let data = try? Data(contentsOf: file), !data.isEmpty else {
      throw captureFailure("screencapture produced no image", detail: detail)
    }
    return data
  }

  /// A capture failure classified by the grant that is actually in force, so a
  /// transient error is retryable and a real denial is actionable.
  private static func captureFailure(_ summary: String, detail: String) -> RPCError {
    let suffix = detail.isEmpty ? "" : ": \(detail)"
    if !CGPreflightScreenCaptureAccess() {
      return RPCError(
        .permissionDenied, "\(summary); grant Screen Recording to this app\(suffix)")
    }
    return RPCError(.internalError, "\(summary)\(suffix)")
  }

  // MARK: - Encoding

  private static func pngData(_ image: CGImage) -> Data? {
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        output, UTType.png.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return output as Data
  }

  /// The fallback path's budget pass: `screencapture` always writes full-scale
  /// pixels, so a capture over budget is decoded, downscaled, and re-encoded
  /// once. The SCK path never reaches here — it is downscaled at the source.
  private static func downscaleAndEncode(_ png: Data, maxDimension: Int) throws -> String {
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
    guard let scaled = context.makeImage(), let encoded = pngData(scaled) else {
      return png.base64EncodedString()
    }
    return encoded.base64EncodedString()
  }
}
