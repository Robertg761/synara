# Synara computer-use capture notes

Date: 2026-08-15

Host: Fedora, KDE Plasma 6.7.3, KWin 6.7.3, Wayland, three monitors.

Scope: Phase 2 capture research and small probes only. The probes and this note
are the only files changed for this spike. No KWin plugin was loaded or unloaded,
no package or project build command was run, and no bun command was run.

## Executive result

The best KDE path is compositor-owned capture in the existing Synara KWin plugin.
Use it for both low-rate perception stills and the live view. It avoids portal
consent, captures the composed window rather than only a client buffer, and can
reuse the same window identity already exposed by the plugin.

The specific Phase 2 split should be:

1. Still image: add a plugin capture request that renders one selected window or
   region into an offscreen target. Return a bounded encoded image to the server
   over a Unix file descriptor or a bounded shared-memory handoff. Start with
   PNG for text-heavy agent perception. Add JPEG as an explicit lower-cost option.
2. Live view: keep capture and target selection in the plugin, then hand frames to
   a server-side encoder through a bounded local transport. Use H.264 Annex B on
   the existing dedicated computer-frame WebSocket. A later optimization can
   replace the local raw handoff with a PipeWire or DMA-BUF producer if profiling
   shows GPU readback is the bottleneck.
3. Portal ScreenCast: implement as a consent-aware fallback for non-KWin or for a
   KWin installation where the plugin capture path is unavailable. Do not make a
   first-run agent perception loop depend on a portal dialog.
4. KWin ScreenShot2 from a normal process: keep as a diagnostic or optional
   adapter for an installed, authorized desktop application. Do not assume an
   arbitrary Node daemon can call it.

The live-bus part of the sandboxed spike run could not reach the host session.
The sandbox can see /run/user/1000/bus, but the user-bus transport rejects it
with Operation not permitted; pw-cli is isolated in the same way. A follow-up
unsandboxed run of the same one-shot probe on the host session closed the gap:
KWin dispatched the CaptureArea call and rejected it with
org.kde.KWin.ScreenShot2.Error.NoAuthorized ("The process is not authorized to
take a screenshot", 5.4 ms round trip). The restricted-interface gating is now
an observed fact on this machine, not an inference from source.

The busctl suggestion to use a host-machine transport was also tried as a
read-only check. It failed with Protocol error and Transport endpoint is not
connected. A direct PipeWire query failed with Operation not permitted.

## Evidence and probe boundary

The following command was run from the Synara checkout:

```text
rpm -q kwin kwin-common kwin-devel kwin-libs kpipewire pipewire wireplumber \
  xdg-desktop-portal xdg-desktop-portal-kde
```

Relevant installed versions:

```text
kwin-6.7.3-1.fc44.x86_64
kwin-common-6.7.3-1.fc44.x86_64
kwin-devel-6.7.3-1.fc44.x86_64
kwin-libs-6.7.3-1.fc44.x86_64
kpipewire-6.7.3-1.fc44.x86_64
pipewire-1.6.8-1.fc44.x86_64
wireplumber-0.5.14-1.fc44.x86_64
xdg-desktop-portal-1.22.1-1.fc44.x86_64
xdg-desktop-portal-kde-6.7.3-1.fc44.x86_64
```

The probes intentionally use no permission-bypass environment variable and make
no repeated attempts. The capture probe makes one D-Bus call per invocation. The
portal probe makes no session calls at all, so this run triggered zero consent
dialogs.

## 1. KWin org.kde.KWin.ScreenShot2

### Exact API shape on this host

The installed KWin screenshot plugin is
/usr/lib64/qt6/plugins/kwin/plugins/screenshot.so. Its embedded introspection
XML reports this interface at service org.kde.KWin, object
/org/kde/KWin/ScreenShot2:

| Method              | D-Bus input signature                              | Return        |
| ------------------- | -------------------------------------------------- | ------------- |
| CaptureWindow       | s handle, a{sv} options, h pipe                    | a{sv} results |
| CaptureActiveScreen | a{sv} options, h pipe                              | a{sv} results |
| CaptureArea         | i x, i y, u width, u height, a{sv} options, h pipe | a{sv} results |

The same current interface also exposes CaptureActiveWindow, CaptureScreen,
CaptureInteractive, CaptureWorkspace, and a read-only Version property. The h
argument is a Unix file descriptor, not a filename and not an image returned in
the D-Bus message.

A normal client call has this shape:

```text
read_fd, write_fd = pipe()
results = ScreenShot2.CaptureArea(
    x, y, width, height,
    {
        "include-cursor": false,
        "include-decoration": true,
        "include-shadow": false,
        "native-resolution": true,
    },
    UnixFd(write_fd),
)
raw_bytes = read_until_eof(read_fd)
```

The reader must drain the pipe while the D-Bus call is in flight. A large image
can fill the pipe buffer before KWin finishes its method. The probe does this in
a reader thread and reports both D-Bus return time and pipe-complete time.

### Authorization result

KWin's ScreenShot2 implementation performs an application authorization check.
The KWin interface source documents the required desktop-entry permission:
the caller's desktop file must list org.kde.KWin.ScreenShot2 in
X-KDE-DBUS-Restricted-Interfaces. KDE Spectacle's current README also warns
that a locally built screenshot client can be rejected by the installed KWin and
lists the two diagnostic bypass variables. Those variables are for development
diagnosis only and are not a Synara integration path.

The practical result is:

| Caller                                                                          | Expected result                                                                                                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged desktop application with the restricted interface in its desktop entry | Can be authorized, subject to KWin's application identity checks                                                                             |
| Arbitrary Node process or daemon with no authorized desktop entry               | Rejected before capture by KWin's permission check                                                                                           |
| Synara code running inside the KWin plugin                                      | Already has compositor authority; use its internal capture path instead of calling the public restricted interface through a loopback client |

Observed live on this host (unsandboxed follow-up run of the same probe):

```text
D-BUS-UNAVAILABLE-OR-CALL-FAILED: DBusException: org.kde.KWin.ScreenShot2.Error.NoAuthorized: The process is not authorized to take a screenshot
method=area call_elapsed_ms=5.423
```

KWin dispatched the call and its permission check rejected the caller before any
capture. This is the observed NoAuthorized reply, confirming the table above: an
arbitrary daemon cannot call ScreenShot2 on this machine.

### Still format and metadata

ScreenShot2 writes raw image bytes to the supplied fd. It does not return PNG or
JPEG. The installed implementation references QImage::format(), width(),
height(), bytesPerLine(), devicePixelRatio(), and sizeInBytes(). The client
should treat the result map as metadata and must not assume `width * height * 4`.

The result map used by current KWin clients is expected to carry fields in this
family:

| Field         | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| type          | Raw image result rather than an encoded image            |
| width, height | Image dimensions                                         |
| format        | Numeric Qt QImage::Format value, not a MIME type         |
| stride        | Bytes per row when supplied by the implementation        |
| scale         | Device-pixel ratio or capture scale                      |
| Target fields | Screen, window, or other source identity when applicable |

Use native-resolution=true when the agent needs physical pixels. Keep the
logical-to-physical scale in the response. include-cursor=false is preferable
for an agent image because Synara can send its own agent-cursor position as
metadata and draw it in the web pane without confusing it with the user's
cursor. CaptureArea accepts integer compositor coordinates; verify the
logical-to-physical mapping against the returned scale on this multi-monitor
desktop.

### Latency

No successful still latency was measured in this sandbox. The one attempted
capture failed before service dispatch:

```text
D-BUS-UNAVAILABLE-OR-CALL-FAILED: DBusException: org.freedesktop.DBus.Error.AccessDenied: Failed to connect to socket /run/user/1000/bus: Operation not permitted
method=area call_elapsed_ms=0.057
```

The 0.057 ms number is a bus-access failure, not capture latency. A successful
call includes scene rendering, GPU readback, a pipe copy, and any later image
encoding. The installed screenshot binary references
EglContext::epoxy_glReadnPixels and QImage, so the readback cost is real rather
than a metadata-only operation.

The next unsandboxed measurement should record p50 and p95 for a 320x200 area,
one window, and one full screen, with separate timings for D-Bus return, pipe
EOF, and PNG or JPEG encoding. Until that measurement exists, treat ScreenShot2
as a low-rate still API, not a 10 to 30 fps stream API. The probe writes a raw
file only after a successful call and refuses to overwrite an existing file
outside /tmp.

## 2. KDE xdg-desktop-portal ScreenCast and PipeWire

### Local KDE routing

The installed portal files select the KDE backend for this session:

```text
/usr/share/xdg-desktop-portal/portals/kde.portal
  DBusName=org.freedesktop.impl.portal.desktop.kde
  ...org.freedesktop.impl.portal.ScreenCast...
  UseIn=KDE

/usr/share/xdg-desktop-portal/kde-portals.conf
  [preferred]
  default=kde

/usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.kde.service
  Name=org.freedesktop.impl.portal.desktop.kde
  Exec=/usr/libexec/xdg-desktop-portal-kde
```

The installed public ScreenCast XML is version 6. It advertises monitor,
window, and virtual sources, plus hidden, embedded, and metadata cursor modes.
The local KDE backend XML adds KDE-specific restore data. pw-cli and
busctl --user introspect could not reach the host session from this sandbox,
so the following flow is based on the installed contract and the official portal
specification, not on a live stream.

### Headless or daemon flow

Headless still means a daemon running inside a graphical user's D-Bus session.
A system daemon without that user session cannot use the KDE portal to capture
the desktop. The server-side flow is:

1. Establish a stable application identity and generate unique handle_token and
   session_handle_token values.
2. Call CreateSession(a{sv}). Wait for the returned
   org.freedesktop.portal.Request::Response signal and extract the session
   object path.
3. Call SelectSources(session, options) once. For a single target use
   multiple=false. Select types=2 for windows or types=1 for monitors.
   Select cursor_mode=1 to hide the cursor if Synara will draw its own.
4. Call Start(session, parent_window, options) once. The method returns a
   request handle. Wait for its Response signal. The parent_window string
   may be empty for a daemon, but a visible parent is better for a user-facing
   Synara window.
5. Read streams from the response. On portal version 6, prefer the stream's
   pipewire-serial property for targeting over the reusable numeric node id.
6. Call OpenPipeWireRemote(session, options) and pass the returned fd to
   pw_context_connect_fd. Only the stream nodes from that remote are visible.
7. Negotiate the PipeWire video format, consume frames, and close the portal
   session on stop, error, or KWin session teardown.

The public D-Bus signatures are:

```text
CreateSession(a{sv} options) -> o request
SelectSources(o session_handle, a{sv} options) -> o request
Start(o session_handle, s parent_window, a{sv} options) -> o request
OpenPipeWireRemote(o session_handle, a{sv} options) -> h pipewire_fd
```

The first three calls are request-based. A method return is not the user's
decision; the client must watch the request object's Response signal and
handle cancellation. A failed or cancelled Start ends that attempt. Do not retry
Start on the same session. Create a new session only when the user explicitly
asks for another attempt.

### Consent and persistence

Yes, a new ScreenCast session normally has an interactive consent and source
selection step at Start. The portal specification explicitly allows Start to
present a dialog and allows an application to attempt it only once.

The consent can be persisted, but persistence is conditional on the user and
backend granting it:

| Option         | Meaning                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| persist_mode=0 | No persistence                                                                                                  |
| persist_mode=1 | Permission persists while the application is running                                                            |
| persist_mode=2 | Permission persists until explicitly revoked                                                                    |
| restore_token  | Single-use token passed to the next SelectSources; replace it with the new token returned by a successful Start |

If the stored source is gone or permission was withdrawn, KDE ignores the
restore data and prompts normally. KDE's backend-specific restore_data is
vendor data and must be treated as opaque. Synara should store it only in its
protected per-user state and never log it.

This run made zero portal session calls. There was no consent dialog and no
attempt to test a restore token. Phase 2 should make the pending-consent state
visible in the UI and spend the one allowed Start attempt only in an explicit
manual test. A daemon must not block a server worker waiting for a dialog.

## 3. Capture inside the KWin plugin

### Header surface present on this host

The installed kwin-devel-6.7.3 headers expose the pieces needed to render a
filtered scene into an offscreen target:

| Header/API               | Relevant surface                                         | Use in a capture implementation                                         |
| ------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| core/rendertarget.h      | RenderTarget(GLFramebuffer _) and RenderTarget(QImage _) | Choose a GPU FBO or CPU image destination                               |
| opengl/gltexture.h       | GLTexture::allocate, render, toImage                     | Allocate an offscreen color texture and read it back when needed        |
| opengl/glframebuffer.h   | FBO constructors, push/pop, blitFromRenderTarget         | Render or scale into a texture-backed target                            |
| scene/scene.h            | SceneView, ItemView, ItemTreeView, Scene::paint          | Drive a scene render for an output or selected item                     |
| scene/scene.h            | SceneView::setViewport, setScale, addWindowFilter, paint | Crop, scale, and exclude unrelated windows                              |
| scene/itemrenderer.h     | beginFrame, endFrame, renderItem                         | Render the scene items into a RenderTarget                              |
| scene/surfaceitem.h      | buffer, texture, buffer size and damage                  | Inspect a client surface when raw client content is deliberately wanted |
| core/graphicsbuffer.h    | map(Read), stride, DMA-BUF and SHM attributes            | Access a client buffer, subject to its lifetime and ownership           |
| effect/offscreeneffect.h | Redirect a window into an offscreen texture              | Reference for effects that already need offscreen window content        |

SceneView is not a simple public captureWindow(Window \*) call. Its constructor
needs a Scene, LogicalOutput, BackendOutput, and OutputLayer. That is why the
KWin screenshot implementation has to participate in KWin's render lifecycle.
Effect::paintScreen and related methods document that KWin keeps the graphics
context current during paint stages. A D-Bus slot must queue work to that
lifecycle rather than issuing arbitrary GL calls from a request handler.

### Proof from KWin's built-in screenshot plugin

The installed screenshot.so references these symbols:

```text
KWin::SceneView::SceneView
KWin::SceneView::addWindowFilter
KWin::SceneView::prePaint
KWin::SceneView::paint
KWin::SceneView::postPaint
KWin::ItemTreeView::ItemTreeView
KWin::GLFramebuffer::GLFramebuffer
KWin::GLFramebuffer::pushFramebuffer
KWin::RenderTarget::RenderTarget
KWin::EglContext::epoxy_glReadnPixels
QImage::sizeInBytes
KWin::Window::excludeFromCapture
```

This is strong local evidence that KWin's own still-capture path is an
offscreen, filtered scene render followed by pixel readback. It is not evidence
that the private APIs are ABI-stable. KWin's source tree also has a separate
PipeWire screencast implementation, but its manager is not exposed as a stable
plugin-level capture interface in the installed headers.

### Feasibility verdict

**Low-rate stills: high feasibility.** The Synara plugin already has access to
KWin's scene and window objects. A capture request can resolve the existing
window UUID, construct a filtered view, render a bounded target, and hand the
result to an encoder. The implementation should follow KWin's screenshot code
closely, not read only SurfaceItem::buffer().

**Live stream: medium feasibility.** The render path exists, but a safe stream
needs a render-thread request queue, a small ring of buffers, backpressure, and a
transport out of the compositor. The installed headers do not provide a
ready-made SceneView to PipeWire helper for an out-of-tree plugin. Direct
PipeWire or DMA-BUF export is worth doing after the still path works, but it is
not a one-method extension.

**Raw client buffers: not a general answer.** SurfaceItem::buffer() gives the
client surface, not necessarily decorations, shadows, compositor effects, or
the final transformed pixels. It also has buffer-release lifetime rules. Use it
only for a deliberate surface-only mode.

### Safe plugin shape

The plugin should own target resolution and capture authorization:

1. The server calls a plugin method with a known window UUID or bounded desktop
   region. Never select a window by a title substring at capture time.
2. The plugin queues a request for the next safe render pass. It resolves the
   Window \*, honors excludeFromCapture(), selects the output and scale, and
   renders into a texture-backed RenderTarget.
3. The render pass performs only the GPU work needed to fill a ring slot. It must
   not block on a D-Bus caller or a WebSocket.
4. A worker or server-side helper reads the slot, downsizes if needed, and
   encodes PNG, JPEG, or H.264. It then writes to the server-owned transport.
5. Window destruction, KWin restart, output hotplug, and a full ring must produce
   an explicit capture error or a dropped frame. They must not leave a stale
   pointer or block KWin's render loop.

For the first local handoff, a Unix socket or shared-memory ring is simpler than
making the plugin a PipeWire client. A passed QDBusUnixFileDescriptor can set
up that handoff, but the plugin must use a bounded queue and a worker writer.
The production live path can then move the ring to DMA-BUF or a PipeWire
producer without changing the web transport.

## 4. Phase 2 recommendation and WebSocket format

### Decision table

| Path                              | Still suitability                               | Live suitability                     | Consent                                                               | Cost and risk                                                     | Decision                                 |
| --------------------------------- | ----------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| KWin plugin scene capture         | Excellent for selected windows and regions      | Good once the ring and encoder exist | No portal dialog; plugin installation is the explicit trust boundary  | KWin-private ABI, GPU readback, compositor-thread discipline      | Primary on KDE                           |
| External ScreenShot2              | Good only for an authorized desktop application | Poor; it is a per-capture still API  | KWin restricted-interface authorization                               | Raw QImage pipe, D-Bus and readback per still                     | Optional adapter, not the daemon default |
| Portal ScreenCast + PipeWire      | Usable for a still by taking one stream frame   | Excellent standard live transport    | Interactive Start normally required; restore can reduce later prompts | Async request lifecycle, app identity, token and hotplug handling | Fallback and portability path            |
| SurfaceItem or client buffer read | Surface-only                                    | Not a general desktop view           | None                                                                  | Omits compositor composition and has buffer lifetime hazards      | Do not use as the general path           |

### Still path for agent perception

Implement captureStill(windowId, region, scale, format) in the KWin plugin
interface. The request should return dimensions, scale, format, capture time,
and an encoded payload through a local fd. The server can expose a PNG data URL
or an equivalent bounded image response to the agent, matching the existing
Androdex driver shape. Keep the image below a server-defined size limit and
downscale large monitors before encoding.

Recommended defaults:

- selected window or a small region, not all three monitors;
- native pixels only when the target is small enough, otherwise a bounded
  logical-pixel scale;
- PNG for text, controls, and screenshots that the model must read precisely;
- JPEG quality 75 to 85 as an opt-in faster mode for photo-like surfaces;
- cursor hidden in the pixels, with Synara's agent cursor position carried as
  separate metadata.

Do not call CaptureArea through D-Bus for every perception tick. The plugin
already has the authority and the window objects, so an internal render avoids
the external authorization dependency and one unnecessary process boundary.

### Live view path for the web pane

Use one encoder per active computer capture target and share its output with
subscribers. The flow should be:

```text
KWin SceneView / offscreen target
        -> bounded ring or PipeWire/DMA-BUF handoff
        -> server-side H.264 encoder
        -> ComputerFrameTransport
        -> /ws/computer-frames
        -> web ComputerPanel
```

The repository already has the shared computer frame envelope in
packages/shared/src/computerFrame.ts and the device-shaped reference in
packages/shared/src/deviceFrame.ts. Reuse the existing little-endian envelope:

```text
u16 magic, u8 version, u8 flags, u32 sequence, f64 timestampMs,
u8 stream-id length, UTF-8 stream id, encoded payload
```

Use computerId as the stream id. Keep the frame socket separate from JSON RPC
and do not enable per-message deflate for H.264. The existing transport's
keyframe-aware behavior is the right model:

- H.264 Annex B access units as payloads;
- codec configuration with SPS/PPS marked by codecConfig;
- IDR frames marked by keyframe;
- a sequence number and capture timestamp on every frame;
- a bounded queue, with slow subscribers dropped to the next clean keyframe;
- a small resync message from the browser when it loses a sequence or decoder
  configuration.

Start the web view at 1280x720 or the selected window's bounded size, 10 to 15
fps, and a one-second keyframe interval. Tune bitrate after measuring the host.
If the capture handoff produces BGRx or RGBA, encode it on the server or in a
supervised native helper. Do not send raw 4-byte pixels over the WebSocket.

The raw-memory cost is easy to bound: 1280x720 BGRA is about 3.52 MiB per frame,
or about 35 MiB/s at 10 fps before encoding. 1920x1080 is about 7.91 MiB per
frame. The current device transport uses a queue limit of 8 and a 2 MiB socket
budget; the computer stream should reuse those bounds or justify a measured
change.

The web pane should receive cursor position, visibility, target bounds, and scale
as a small side-channel state update. This keeps cursor behavior stable when a
window-only capture excludes the compositor overlay and avoids baking a second
cursor into the video stream.

### Portal fallback

When the KWin plugin is not available, the backend may request a portal stream.
It should persist a single-use restore token only after the user grants the
requested persistence mode. It should expose these states to the web pane:

```text
idle -> requesting-consent -> starting -> streaming
                         -> denied/cancelled/error
streaming -> closed/reconnect-required
```

The fallback must never silently retry a denied Start. If a restored session is
invalid, return to requesting-consent and wait for a new explicit user action.

## Probe transcripts

All probe files are under apps/server/native/capture-probe/. They have comment
headers and can be run standalone on a normal KDE user session.

### ScreenShot2 introspection

Command:

```text
./apps/server/native/capture-probe/kwin-screenshot2-introspect.sh
```

Trimmed output:

```text
== KWin ScreenShot2 read-only probe ==
service=org.kde.KWin object=/org/kde/KWin/ScreenShot2 interface=org.kde.KWin.ScreenShot2
packages: kwin-6.7.3-1.fc44.x86_64
kwin-common-6.7.3-1.fc44.x86_64
kwin-devel-6.7.3-1.fc44.x86_64
--- live user-bus introspection (read-only) ---
Failed to connect to user scope bus via local transport: Operation not permitted
--- qdbus-qt6 fallback (read-only) ---
Could not connect to D-Bus server: ... /run/user/1000/bus: Operation not permitted
--- local KWin screenshot plugin evidence ---
plugin=/usr/lib64/qt6/plugins/kwin/plugins/screenshot.so
org.kde.KWin.ScreenShot2
<method name="CaptureWindow">
<method name="CaptureArea">
<method name="CaptureActiveScreen">
```

The same local binary showed the a{sv} options map, h pipe fd, and a{sv}
result map for each method.

### One normal-process capture attempt

Command:

```text
./apps/server/native/capture-probe/kwin-screenshot2-capture.py --method area
```

Trimmed output:

```text
D-BUS-UNAVAILABLE-OR-CALL-FAILED: DBusException: org.freedesktop.DBus.Error.AccessDenied: Failed to connect to socket /run/user/1000/bus: Operation not permitted
method=area call_elapsed_ms=0.057
```

No /tmp/synara-kwin-capture-\*.raw file was created. The failure happened before
KWin could evaluate the caller's restricted-interface authorization.

### Portal contract and routing

Command:

```text
./apps/server/native/capture-probe/portal-screencast-probe.sh
```

Trimmed output:

```text
== xdg-desktop-portal ScreenCast read-only probe ==
service=org.freedesktop.portal.Desktop object=/org/freedesktop/portal/desktop interface=org.freedesktop.portal.ScreenCast
desktop=KDE current_desktop=KDE
DBusName=org.freedesktop.impl.portal.desktop.kde
...org.freedesktop.impl.portal.ScreenCast...
UseIn=KDE
CreateSession
SelectSources
restore_token
persist_mode
Start
pipewire-serial
OpenPipeWireRemote
Failed to connect to user scope bus via local transport: Operation not permitted
Start is the consent boundary; this script intentionally never reaches it.
```

The script only reads local config/XML and performs read-only introspection. It
does not call CreateSession, SelectSources, Start, or OpenPipeWireRemote.

### KWin header and implementation inventory

Command:

```text
./apps/server/native/capture-probe/kwin-header-capture-inventory.sh
```

Trimmed output:

```text
kwin-6.7.3-1.fc44.x86_64
file=/usr/include/kwin/core/rendertarget.h
23: explicit RenderTarget(GLFramebuffer *fbo, ...)
24: explicit RenderTarget(QImage *image, ...)
file=/usr/include/kwin/opengl/gltexture.h
98: QImage toImage()
file=/usr/include/kwin/scene/scene.h
103: explicit SceneView(Scene *scene, LogicalOutput *, BackendOutput *, OutputLayer *)
133: void addWindowFilter(std::function<bool (Window *)> filter)
--- built-in screenshot implementation symbols ---
KWin::SceneView::addWindowFilter
KWin::ItemTreeView::ItemTreeView
KWin::GLFramebuffer::GLFramebuffer
KWin::EglContext::epoxy_glReadnPixels
KWin::Window::excludeFromCapture
```

## Open risks and next measurements

- The ScreenShot2 permission result has since been obtained unsandboxed:
  NoAuthorized for a normal process, as predicted. Still pending live
  measurement: successful raw capture metadata (needs an authorized caller or
  the plugin path) and PipeWire format negotiation.
- KWin scene and render APIs are private, version-pinned, and sensitive to
  render-thread timing. The Phase 0 plugin already has an explicit KWin version
  gate; capture must stay behind the same gate.
- Direct GPU readback can stall the compositor. Measure 320x200, one window, and
  full-screen p50/p95 before choosing a live frame rate. Watch frame misses and
  KWin render latency, not only server CPU time.
- Window-only composition needs an explicit policy for decorations, shadows,
  minimized windows, occluded windows, and KWin's excludeFromCapture flag.
- Multi-monitor logical coordinates, per-output scale, rotation, HDR/color
  descriptions, and hotplug can change the image dimensions while a stream is
  active.
- Portal restore state is scoped to an application identity and KDE's backend.
  A changed window, monitor, permission, or desktop environment can invalidate
  it. Never treat a stored token as permanent permission.
- The plugin is compositor-level trusted code. Captured pixels and portal state
  need the same thread/session authorization and redaction posture as computer
  control. The frame WebSocket must not become an unauthenticated side channel.
- A PipeWire/DMA-BUF producer inside the plugin may be worthwhile for sustained
  live view, but it should be a measured follow-up after the still path and
  bounded local handoff are stable.

## References

- KWin screenshot plugin build and D-Bus adaptor:
  https://lxr.kde.org/source/plasma/kwin/src/plugins/screenshot/CMakeLists.txt?v=stable-kf6-qt6
- KWin ScreenShot2 interface source:
  https://invent.kde.org/plasma/kwin/-/blob/master/src/plugins/screenshot/screenshotdbusinterface2.h
- KDE Spectacle KWin image client:
  https://invent.kde.org/plasma/spectacle/-/blob/master/src/Platforms/ImagePlatformKWin.cpp
- KDE Spectacle authorization note:
  https://github.com/KDE/spectacle
- XDG Desktop Portal ScreenCast specification:
  https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html
- KWin screencast implementation sources:
  https://lxr.kde.org/source/plasma/kwin/src/plugins/screencast/
- Local API evidence: /usr/include/kwin/,
  /usr/share/dbus-1/interfaces/org.freedesktop.portal.ScreenCast.xml, and
  /usr/lib64/qt6/plugins/kwin/plugins/screenshot.so.
