/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

// The Hyprland twin of the KWin computer-use plugin.
//
// Same D-Bus surface — `org.synara.ComputerUse` at `/org/synara/ComputerUse`,
// interface `org.synara.ComputerUse1`, the same sixteen methods and the same
// `sessionStopped` signal — so the entire server-side driving path built for
// the KWin plugin works unchanged; only how the plugin gets loaded differs
// (`hyprctl plugin load` here, `org.kde.KWin.Plugins` there).
//
// This plugin only ever runs on the human's live compositor, so it is always
// the `!ownsCompositor` shape of the KWin plugin: the agent gets a drawn ghost
// cursor and per-client direct injection, and never a real seat or the human's
// pointer. See the KWin plugin for the full design discussion; comments here
// cover only what Hyprland does differently.
//
// Threading: everything runs on the compositor thread. The D-Bus connection is
// driven by Hyprland's own Wayland event loop (its fds are registered as event
// sources), so method handlers may touch compositor state directly, exactly
// like the KWin plugin's QDBus slots.

#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/SharedDefs.hpp>
#include <hyprland/src/event/EventBus.hpp>
#include <hyprland/src/render/OpenGL.hpp>
#include <hyprland/src/render/Renderer.hpp>
#include <hyprland/src/render/Texture.hpp>
#include <hyprland/src/render/pass/TexPassElement.hpp>
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/desktop/state/FocusState.hpp>
#include <hyprland/src/desktop/state/ViewState.hpp>
#include <hyprland/src/desktop/state/ViewStateTracker.hpp>
#include <hyprland/src/desktop/state/ViewHitTester.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/Workspace.hpp>
#include <hyprland/src/state/MonitorState.hpp>
#include <hyprland/src/output/Monitor.hpp>
#include <hyprland/src/managers/input/InputManager.hpp>

#include <cairo/cairo.h>
#include <sdbus-c++/sdbus-c++.h>
#include <wayland-server-core.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <format>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#ifndef SYNARA_CU_BUILD_ID
#define SYNARA_CU_BUILD_ID "dev"
#endif
#ifndef SYNARA_CU_GIT_HASH
#define SYNARA_CU_GIT_HASH "unknown"
#endif
#ifndef SYNARA_CU_BUILD_TS
#define SYNARA_CU_BUILD_TS ""
#endif

inline HANDLE PHANDLE = nullptr;

namespace {

// ---------------------------------------------------------------------------
// Constants shared with the KWin plugin. Names and values must stay in lock
// step with synaracomputeruseplugin.cpp: the server treats both plugins as the
// same service.
// ---------------------------------------------------------------------------

constexpr const char* SERVICE_NAME   = "org.synara.ComputerUse";
constexpr const char* OBJECT_PATH    = "/org/synara/ComputerUse";
constexpr const char* INTERFACE_NAME = "org.synara.ComputerUse1";

constexpr const char* ERR_CAPTURE          = "org.synara.ComputerUse.Error.CaptureFailed";
constexpr const char* ERR_RELEASED         = "org.synara.ComputerUse.Error.ControlReleased";
[[maybe_unused]] constexpr const char* ERR_SEAT_UNSUPPORTED = "org.synara.ComputerUse.Error.SeatUnsupported";
[[maybe_unused]] constexpr const char* ERR_HUMAN_ACTIVE     = "org.synara.ComputerUse.Error.HumanActive";

constexpr uint32_t MIN_IDLE_TIMEOUT_MS     = 1000;
constexpr uint32_t MAX_IDLE_TIMEOUT_MS     = 60 * 60 * 1000;
constexpr uint32_t DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

constexpr uint32_t MIN_HUMAN_ACTIVE_GUARD_MS     = 100;
constexpr uint32_t MAX_HUMAN_ACTIVE_GUARD_MS     = 60 * 1000;
constexpr uint32_t DEFAULT_HUMAN_ACTIVE_GUARD_MS = 2000;

constexpr const char* AGENT_FALLBACK_NAME = "Agent";
// The same chord as the KWin plugin, spelled the way the availability card
// shows it. Hyprland has no global-shortcut registry a plugin can use, so the
// chord is recognized from raw key events in the input spy below.
constexpr const char* RELEASE_SHORTCUT_LABEL = "Meta+Shift+Esc";

// evdev keycodes, straight from IKeyboard::SKeyEvent (no xkb +8 offset).
constexpr uint32_t KEYCODE_ESC        = 1;
constexpr uint32_t KEYCODE_LEFTSHIFT  = 42;
constexpr uint32_t KEYCODE_RIGHTSHIFT = 54;
constexpr uint32_t KEYCODE_LEFTMETA   = 125;
constexpr uint32_t KEYCODE_RIGHTMETA  = 126;

// Ghost cursor artwork, identical to the KWin plugin's: Synara violet fill,
// white rim, dark translucent ink outline, and a name badge below-right of the
// hotspot. The silhouette is the same tip-at-origin arrow, in fractions of the
// cursor size.
constexpr struct {
    double x, y;
} CURSOR_OUTLINE[] = {
    {0.00, 0.00}, {0.00, 0.76}, {0.19, 0.58}, {0.30, 0.88}, {0.44, 0.82}, {0.32, 0.54}, {0.56, 0.54},
};

struct SColor {
    double r, g, b, a;
};
constexpr SColor ACCENT_COLOR = {0x7c / 255.0, 0x3a / 255.0, 0xed / 255.0, 1.0};
constexpr SColor RIM_COLOR    = {1.0, 1.0, 1.0, 1.0};
constexpr SColor INK_COLOR    = {0x14 / 255.0, 0x0a / 255.0, 0x2e / 255.0, 0x99 / 255.0};

constexpr double INK_STROKE_RATIO     = 0.085;
constexpr double RIM_STROKE_RATIO     = 0.045;
constexpr double MIN_INK_STROKE_WIDTH = 1.8;
constexpr double MIN_RIM_STROKE_WIDTH = 1.0;
constexpr int    BADGE_MIN_TEXT_PIXELS      = 11;
constexpr double BADGE_MAX_TEXT_WIDTH_RATIO = 8;
constexpr int64_t BADGE_HOLD_MS = 2000;
constexpr int64_t BADGE_FADE_MS = 320;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

double inkStrokeWidth(double size) {
    return std::max(MIN_INK_STROKE_WIDTH, size * INK_STROKE_RATIO);
}

double rimStrokeWidth(double size) {
    return std::max(MIN_RIM_STROKE_WIDTH, size * RIM_STROKE_RATIO);
}

// Transparent room for the strokes, which extend outward past the silhouette on
// every side including the tip. In logical pixels, and therefore also the
// offset from the drawn image's corner to the hotspot.
double strokeMargin(double size) {
    return inkStrokeWidth(size) / 2 + 1;
}

// ---------------------------------------------------------------------------
// JSON building. The KWin plugin has Qt's JSON classes; here a minimal builder
// keeps the payloads byte-compatible without pulling a JSON library into the
// compositor.
// ---------------------------------------------------------------------------

std::string jsonEscape(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (const char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20)
                    out += std::format("\\u{:04x}", static_cast<unsigned char>(c));
                else
                    out += c;
        }
    }
    return out;
}

std::string jsonNumber(double v) {
    if (!std::isfinite(v))
        return "0";
    // Integral values print without a fraction, like Qt's JSON writer.
    if (v == std::floor(v) && std::abs(v) < 1e15)
        return std::format("{}", static_cast<int64_t>(v));
    return std::format("{}", v);
}

class JsonObj {
  public:
    JsonObj& raw(std::string_view key, std::string_view rawValue) {
        m_out += m_first ? "\"" : ",\"";
        m_first = false;
        m_out += jsonEscape(key);
        m_out += "\":";
        m_out += rawValue;
        return *this;
    }
    JsonObj& str(std::string_view key, std::string_view value) {
        return raw(key, "\"" + jsonEscape(value) + "\"");
    }
    JsonObj& num(std::string_view key, double value) {
        return raw(key, jsonNumber(value));
    }
    JsonObj& boolean(std::string_view key, bool value) {
        return raw(key, value ? "true" : "false");
    }
    std::string build() const {
        return "{" + m_out + "}";
    }

  private:
    std::string m_out;
    bool        m_first = true;
};

class JsonArr {
  public:
    JsonArr& raw(std::string_view rawValue) {
        if (!m_out.empty())
            m_out += ",";
        m_out += rawValue;
        return *this;
    }
    JsonArr& str(std::string_view value) {
        return raw("\"" + jsonEscape(value) + "\"");
    }
    std::string build() const {
        return "[" + m_out + "]";
    }

  private:
    std::string m_out;
};

std::string rectJson(const CBox& box) {
    return JsonObj{}.num("x", box.x).num("y", box.y).num("width", box.w).num("height", box.h).build();
}

std::string pointJson(const Vector2D& p) {
    return JsonObj{}.num("x", p.x).num("y", p.y).build();
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

struct SListeners {
    CHyprSignalListener renderStage;
    CHyprSignalListener mouseMove;
    CHyprSignalListener mouseButton;
    CHyprSignalListener mouseAxis;
    CHyprSignalListener keyboardKey;
};

enum class StopReason : uint8_t {
    Request,
    IdleTimeout,
    UserRelease,
};

struct SState {
    bool     running        = false;
    bool     releasedByUser = false;
    uint32_t idleTimeoutMs      = DEFAULT_IDLE_TIMEOUT_MS;
    uint32_t humanActiveGuardMs = DEFAULT_HUMAN_ACTIVE_GUARD_MS;

    std::string agentName;
    std::string stopReason;

    Vector2D pos;

    // Wall-clock bookkeeping, all in steady-clock milliseconds.
    int64_t lastActivityMs   = 0;
    int64_t lastHumanInputMs = -1;

    PHLWINDOWREF pointerWindow;
    PHLWINDOWREF keyboardWindow;
    PHLWINDOWREF targetWindow;
    // Distinct from targetWindow being expired: the ref clears itself when the
    // window dies, and the agent still needs to know it asked for that window
    // so the input path can refuse rather than retarget.
    bool targetRequested = false;

    // Physical keycodes currently held on the human's keyboard, kept only to
    // recognize the release chord.
    std::set<uint32_t> humanHeldKeys;

    // Ghost cursor render state. Textures are (re)built inside the render hook
    // where a GL context is current, whenever `cursorArtDirty` or the output
    // scale changed.
    bool                    cursorVisible = false;
    bool                    cursorArtDirty = true;
    double                  cursorArtScale = 0;
    double                  cursorSize     = 0;
    SP<Render::ITexture>    cursorTex;
    SP<Render::ITexture>    badgeTex;
    Vector2D                cursorTexLogicalSize;
    Vector2D                badgeTexLogicalSize;
    double                  lastBadgeAlpha = 0;

    // D-Bus plumbing, driven from the compositor's event loop.
    std::unique_ptr<sdbus::IConnection> dbus;
    std::unique_ptr<sdbus::IObject>     dbusObject;
    wl_event_source*                    dbusFdSource    = nullptr;
    wl_event_source*                    dbusEvtFdSource = nullptr;
    wl_event_source*                    idleTimerSource = nullptr;

    SListeners listeners;

    std::string hyprlandVersion;
};

SState g;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

std::string windowId(const PHLWINDOW& w) {
    return std::format("{:x}", reinterpret_cast<uintptr_t>(w.get()));
}

PHLWINDOW findWindowById(const std::string& id) {
    std::string hex = id;
    if (hex.starts_with("0x") || hex.starts_with("0X"))
        hex = hex.substr(2);
    uintptr_t address = 0;
    try {
        address = static_cast<uintptr_t>(std::stoull(hex, nullptr, 16));
    } catch (...) {
        return nullptr;
    }
    for (const auto& w : Desktop::windowState()->windows()) {
        if (reinterpret_cast<uintptr_t>(w.get()) == address)
            return w;
    }
    return nullptr;
}

// Every requirement of a window that can be aimed at: mapped, not hidden, and
// on a workspace that is actually on screen.
bool usableWindow(const PHLWINDOW& w) {
    if (!w || !w->m_isMapped || w->isHidden())
        return false;
    if (w->m_workspace && !w->m_workspace->isVisible())
        return false;
    return true;
}

CBox windowBounds(const PHLWINDOW& w) {
    if (const auto box = w->logicalBox(); box.has_value())
        return *box;
    return w->getFullWindowBoundingBox();
}

// The union of every monitor, which is what the KWin plugin reports as the
// workspace geometry. Hyprland has no single-call equivalent, so fold.
CBox workspaceGeometry() {
    bool   any = false;
    double x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    for (const auto& mon : State::monitorState()->monitors()) {
        if (!mon)
            continue;
        const CBox box = mon->logicalBox();
        if (!any) {
            x1 = box.x;
            y1 = box.y;
            x2 = box.x + box.w;
            y2 = box.y + box.h;
            any = true;
        } else {
            x1 = std::min(x1, box.x);
            y1 = std::min(y1, box.y);
            x2 = std::max(x2, box.x + box.w);
            y2 = std::max(y2, box.y + box.h);
        }
    }
    if (!any)
        return CBox{0, 0, 0, 0};
    return CBox{x1, y1, x2 - x1, y2 - y1};
}

PHLWINDOW windowAtPoint(const Vector2D& pos) {
    return Desktop::viewState()->hitTest().windowAt(pos, Desktop::View::RESERVED_EXTENTS | Desktop::View::INPUT_EXTENTS | Desktop::View::ALLOW_FLOATING);
}

// ---------------------------------------------------------------------------
// Ghost cursor drawing (cairo). Layout mirrors the KWin item pixel for pixel:
// the arrow image's corner sits at hotspot - margin, the badge below-right of
// the hotspot, clear of the arrow.
// ---------------------------------------------------------------------------

double agentCursorSize() {
    // The human's own cursor size, so the ghost is the same physical size as
    // the pointer it sits beside. Hyprland publishes it through XCURSOR_SIZE.
    if (const char* env = std::getenv("XCURSOR_SIZE")) {
        const int size = std::atoi(env);
        if (size > 0)
            return size;
    }
    return 24;
}

void cursorPath(cairo_t* cr, double size) {
    cairo_new_path(cr);
    cairo_move_to(cr, CURSOR_OUTLINE[0].x * size, CURSOR_OUTLINE[0].y * size);
    for (size_t i = 1; i < std::size(CURSOR_OUTLINE); ++i)
        cairo_line_to(cr, CURSOR_OUTLINE[i].x * size, CURSOR_OUTLINE[i].y * size);
    cairo_close_path(cr);
}

void setColor(cairo_t* cr, const SColor& c) {
    cairo_set_source_rgba(cr, c.r, c.g, c.b, c.a);
}

void roundedRectPath(cairo_t* cr, double x, double y, double w, double h, double r) {
    cairo_new_path(cr);
    cairo_arc(cr, x + r, y + r, r, M_PI / 2 * 2, M_PI / 2 * 3);
    cairo_arc(cr, x + w - r, y + r, r, M_PI / 2 * 3, M_PI / 2 * 4);
    cairo_arc(cr, x + w - r, y + h - r, r, 0, M_PI / 2);
    cairo_arc(cr, x + r, y + h - r, r, M_PI / 2, M_PI);
    cairo_close_path(cr);
}

struct SRenderedImage {
    cairo_surface_t* surface = nullptr;
    Vector2D         logicalSize;
};

SRenderedImage renderImage(const Vector2D& logicalSize, double scale, auto&& paint) {
    const int pw = std::max(1, static_cast<int>(std::ceil(logicalSize.x * scale)));
    const int ph = std::max(1, static_cast<int>(std::ceil(logicalSize.y * scale)));
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, pw, ph);
    cairo_t*         cr      = cairo_create(surface);
    cairo_scale(cr, scale, scale);
    paint(cr);
    cairo_destroy(cr);
    cairo_surface_flush(surface);
    return {surface, logicalSize};
}

SRenderedImage renderCursorImage(double size, double scale) {
    const double margin  = strokeMargin(size);
    const double boundsW = 0.56 * size; // rightmost outline point
    const double boundsH = 0.88 * size; // lowest outline point
    return renderImage({boundsW + 2 * margin, boundsH + 2 * margin}, scale, [&](cairo_t* cr) {
        cairo_translate(cr, margin, margin);
        cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
        cursorPath(cr, size);
        setColor(cr, INK_COLOR);
        cairo_set_line_width(cr, inkStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, RIM_COLOR);
        cairo_set_line_width(cr, rimStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, ACCENT_COLOR);
        cairo_fill(cr);
    });
}

void selectBadgeFont(cairo_t* cr, double size) {
    cairo_select_font_face(cr, "sans-serif", CAIRO_FONT_SLANT_NORMAL, CAIRO_FONT_WEIGHT_BOLD);
    cairo_set_font_size(cr, std::max(double(BADGE_MIN_TEXT_PIXELS), std::round(size * 0.5)));
}

// Drops whole UTF-8 code points from the end, for the badge's eliding.
void utf8PopBack(std::string& s) {
    while (!s.empty() && (static_cast<unsigned char>(s.back()) & 0xC0) == 0x80)
        s.pop_back();
    if (!s.empty())
        s.pop_back();
}

SRenderedImage renderBadgeImage(const std::string& name, double size, double scale) {
    const double margin = strokeMargin(size);

    // Measure with a scratch context so the real surface can be allocated at
    // the right size before any drawing happens.
    cairo_surface_t* scratchSurface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 1, 1);
    cairo_t*         scratch        = cairo_create(scratchSurface);
    selectBadgeFont(scratch, size);

    std::string text     = name;
    const double maxWidth = size * BADGE_MAX_TEXT_WIDTH_RATIO;
    cairo_text_extents_t textExtents;
    cairo_text_extents(scratch, text.c_str(), &textExtents);
    if (textExtents.x_advance > maxWidth) {
        while (!text.empty()) {
            cairo_text_extents(scratch, (text + "…").c_str(), &textExtents);
            if (textExtents.x_advance <= maxWidth)
                break;
            utf8PopBack(text);
        }
        text += "…";
        cairo_text_extents(scratch, text.c_str(), &textExtents);
    }
    cairo_font_extents_t fontExtents;
    cairo_font_extents(scratch, &fontExtents);
    cairo_destroy(scratch);
    cairo_surface_destroy(scratchSurface);

    const double paddingX = std::round(size * 0.30);
    const double paddingY = std::round(size * 0.14);
    const double bodyW    = std::ceil(textExtents.x_advance + 2 * paddingX);
    const double bodyH    = std::ceil(fontExtents.ascent + fontExtents.descent + 2 * paddingY);

    return renderImage({bodyW + 2 * margin, bodyH + 2 * margin}, scale, [&](cairo_t* cr) {
        const double radius = bodyH / 2;
        roundedRectPath(cr, margin, margin, bodyW, bodyH, radius);
        setColor(cr, INK_COLOR);
        cairo_set_line_width(cr, inkStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, ACCENT_COLOR);
        cairo_fill_preserve(cr);
        setColor(cr, RIM_COLOR);
        cairo_set_line_width(cr, rimStrokeWidth(size));
        cairo_stroke(cr);

        selectBadgeFont(cr, size);
        cairo_text_extents_t te;
        cairo_text_extents(cr, text.c_str(), &te);
        cairo_font_extents_t fe;
        cairo_font_extents(cr, &fe);
        setColor(cr, RIM_COLOR);
        cairo_move_to(cr, margin + (bodyW - te.x_advance) / 2, margin + (bodyH - (fe.ascent + fe.descent)) / 2 + fe.ascent);
        cairo_show_text(cr, text.c_str());
    });
}

// The on-screen footprint of the arrow, in global logical coordinates.
CBox cursorBox() {
    const double size   = g.cursorSize > 0 ? g.cursorSize : agentCursorSize();
    const double margin = strokeMargin(size);
    const Vector2D texSize = g.cursorTexLogicalSize.x > 0 ? g.cursorTexLogicalSize : Vector2D{0.56 * size + 2 * margin, 0.88 * size + 2 * margin};
    return CBox{g.pos.x - margin, g.pos.y - margin, texSize.x, texSize.y};
}

// Below and right of the hotspot, clear of the arrow, so the badge never covers
// the pixel the agent is about to click.
CBox badgeBox() {
    const double size   = g.cursorSize > 0 ? g.cursorSize : agentCursorSize();
    const double margin = strokeMargin(size);
    const Vector2D texSize = g.badgeTexLogicalSize.x > 0 ? g.badgeTexLogicalSize : Vector2D{size * 4, size};
    return CBox{g.pos.x + std::round(size * 0.55) - margin, g.pos.y + std::round(size * 0.90) - margin, texSize.x, texSize.y};
}

void damageCursorArea() {
    if (!g_pHyprRenderer)
        return;
    g_pHyprRenderer->damageBox(cursorBox());
    g_pHyprRenderer->damageBox(badgeBox());
}

double easeInOutQuad(double t) {
    return t < 0.5 ? 2 * t * t : 1 - std::pow(-2 * t + 2, 2) / 2;
}

// 1 while held after activity, easing to 0 over the fade window — the KWin
// badge's hold-then-fade, computed per frame instead of with an animation
// object.
double badgeAlpha() {
    const int64_t elapsed = nowMs() - g.lastActivityMs;
    if (elapsed < BADGE_HOLD_MS)
        return 1;
    if (elapsed < BADGE_HOLD_MS + BADGE_FADE_MS)
        return 1 - easeInOutQuad(double(elapsed - BADGE_HOLD_MS) / BADGE_FADE_MS);
    return 0;
}

void ensureCursorTextures(double scale) {
    const double size = agentCursorSize();
    if (!g.cursorArtDirty && g.cursorArtScale == scale && g.cursorSize == size && g.cursorTex)
        return;

    SRenderedImage cursor = renderCursorImage(size, scale);
    SRenderedImage badge  = renderBadgeImage(g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName, size, scale);

    g.cursorTex            = g_pHyprRenderer->createTexture(cursor.surface);
    g.badgeTex             = g_pHyprRenderer->createTexture(badge.surface);
    g.cursorTexLogicalSize = cursor.logicalSize;
    g.badgeTexLogicalSize  = badge.logicalSize;
    cairo_surface_destroy(cursor.surface);
    cairo_surface_destroy(badge.surface);

    g.cursorArtDirty = false;
    g.cursorArtScale = scale;
    g.cursorSize     = size;
}

void onRenderLastMoment() {
    if (!g.running || !g.cursorVisible || !g_pHyprRenderer)
        return;
    const auto monitor = g_pHyprRenderer->m_renderData.pMonitor.lock();
    if (!monitor)
        return;

    const CBox monitorBox = monitor->logicalBox();
    const CBox arrow      = cursorBox();
    const CBox badge      = badgeBox();
    const double alpha    = badgeAlpha();

    const auto overlaps = [&](const CBox& box) {
        return box.x < monitorBox.x + monitorBox.w && box.x + box.w > monitorBox.x && box.y < monitorBox.y + monitorBox.h && box.y + box.h > monitorBox.y;
    };
    if (!overlaps(arrow) && !(alpha > 0 && overlaps(badge)))
        return;

    ensureCursorTextures(monitor->m_scale);
    if (!g.cursorTex)
        return;

    // Pass element boxes are monitor-local pixels, like every box the core
    // renderer queues.
    const auto toLocal = [&](CBox box) {
        return box.translate(-monitor->m_position).scale(monitor->m_scale).round();
    };

    if (alpha > 0 && g.badgeTex && overlaps(badge)) {
        CTexPassElement::SRenderData data;
        data.tex = g.badgeTex;
        data.box = toLocal(badge);
        data.a   = static_cast<float>(alpha);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }
    if (overlaps(arrow)) {
        CTexPassElement::SRenderData data;
        data.tex = g.cursorTex;
        data.box = toLocal(arrow);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }
}

// Keeps the badge fade animating: while its alpha is changing, each rendered
// frame damages the badge so the next one gets scheduled.
void onRenderPre() {
    if (!g.running || !g.cursorVisible)
        return;
    const double alpha = badgeAlpha();
    if (alpha != g.lastBadgeAlpha) {
        g.lastBadgeAlpha = alpha;
        if (g_pHyprRenderer)
            g_pHyprRenderer->damageBox(badgeBox());
    }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const char* stopReasonName(StopReason reason) {
    switch (reason) {
        case StopReason::IdleTimeout: return "idle-timeout";
        case StopReason::UserRelease: return "user-release";
        case StopReason::Request: break;
    }
    return "request";
}

void armIdleTimer() {
    if (!g.idleTimerSource)
        return;
    if (g.running && g.idleTimeoutMs > 0) {
        const int64_t remaining = int64_t(g.idleTimeoutMs) - (nowMs() - g.lastActivityMs);
        wl_event_source_timer_update(g.idleTimerSource, static_cast<int>(std::max<int64_t>(1, remaining)));
    } else {
        wl_event_source_timer_update(g.idleTimerSource, 0);
    }
}

void noteActivity() {
    g.lastActivityMs = nowMs();
    armIdleTimer();
    if (g.running && g.cursorVisible && g_pHyprRenderer)
        g_pHyprRenderer->damageBox(badgeBox());
}

int64_t idleMilliseconds() {
    return nowMs() - g.lastActivityMs;
}

int64_t humanInputAgeMilliseconds() {
    if (g.lastHumanInputMs < 0)
        return -1;
    return nowMs() - g.lastHumanInputMs;
}

void setCursorVisible(bool visible) {
    if (g.cursorVisible == visible)
        return;
    g.cursorVisible = visible;
    damageCursorArea();
}

void emitSessionStopped(const std::string& reason) {
    if (!g.dbusObject)
        return;
    try {
        g.dbusObject->emitSignal("sessionStopped").onInterface(INTERFACE_NAME).withArguments(reason);
    } catch (...) {
        // A failed diagnostic signal must never take the session logic down.
    }
}

void stopSession(StopReason reason) {
    const bool wasRunning = g.running;
    const bool latching   = reason == StopReason::UserRelease;
    const bool changed    = wasRunning || (latching && !g.releasedByUser);

    g.running = false;
    setCursorVisible(false);
    g.pointerWindow.reset();
    g.keyboardWindow.reset();
    g.targetWindow.reset();
    g.targetRequested = false;
    g.stopReason      = stopReasonName(reason);
    // Only the human's panic switch latches. An idle timeout is routine, and an
    // explicit server stop ends the session the server itself owns, so both
    // leave the next start() free to run.
    g.releasedByUser = latching;
    armIdleTimer();

    if (changed)
        emitSessionStopped(g.stopReason);
}

// Pressing the chord again hands control back without a trip through Synara,
// so a panic stop can never strand the feature.
void handleReleaseShortcut() {
    if (!g.running && g.releasedByUser) {
        g.releasedByUser = false;
        g.stopReason     = "user-resume";
        return;
    }
    stopSession(StopReason::UserRelease);
}

bool requireRunning() {
    if (!g.running)
        return false;
    noteActivity();
    return true;
}

// ---------------------------------------------------------------------------
// D-Bus methods
// ---------------------------------------------------------------------------

std::string healthJson() {
    JsonObj health;
    health
        // Milestone gate: flips to the real input-path readiness check when
        // direct injection lands.
        .boolean("ok", true)
        .boolean("running", g.running)
        .str("service", SERVICE_NAME)
        .str("path", OBJECT_PATH)
        .str("interface", INTERFACE_NAME)
        .str("build", SYNARA_CU_BUILD_ID)
        .str("gitHash", SYNARA_CU_GIT_HASH)
        .str("buildTimestamp", SYNARA_CU_BUILD_TS)
        .str("compositor", "hyprland")
        .str("hyprlandVersion", g.hyprlandVersion)
        // Always the human's live compositor, so always the KWin plugin's
        // shared-desktop shape: no real agent seat, direct per-client
        // injection, ghost cursor drawn by the plugin.
        .str("seat", "synara-agent")
        .boolean("dedicatedSeat", true)
        .boolean("ownsCompositor", false)
        .boolean("directInjection", true)
        .boolean("overlay", true)
        .boolean("workspace", static_cast<bool>(Desktop::windowState()))
        .str("xDisplay", std::getenv("DISPLAY") ? std::getenv("DISPLAY") : "")
        .boolean("effects", true)
        // Flips when the capture pipeline lands.
        .boolean("capture", false)
        .num("idleTimeoutMs", g.idleTimeoutMs)
        .boolean("releasedByUser", g.releasedByUser)
        .str("releaseShortcut", RELEASE_SHORTCUT_LABEL)
        .raw("workspaceGeometry", rectJson(workspaceGeometry()));
    return health.build();
}

std::string stateJson() {
    JsonObj state;
    state.boolean("running", g.running)
        .str("seat", "synara-agent")
        .boolean("dedicatedSeat", true)
        .boolean("ownsCompositor", false)
        .boolean("directInjection", true)
        .raw("position", pointJson(g.pos))
        // The human's own cursor, reported next to the agent's because the one
        // property this whole design rests on is that these two move
        // independently.
        .raw("humanPosition", pointJson(g_pInputManager ? g_pInputManager->getMouseCoordsInternal() : Vector2D{}))
        .str("agentName", g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName)
        .num("pressedButtonCount", 0)
        .num("pressedKeyCount", 0)
        .num("idleTimeoutMs", g.idleTimeoutMs)
        .num("idleMs", double(idleMilliseconds()))
        .boolean("releasedByUser", g.releasedByUser)
        .str("releaseShortcut", RELEASE_SHORTCUT_LABEL);
    if (g.running && g.idleTimeoutMs > 0)
        state.num("idleRemainingMs", double(std::max<int64_t>(0, int64_t(g.idleTimeoutMs) - idleMilliseconds())));
    if (!g.stopReason.empty())
        state.str("stopReason", g.stopReason);
    if (const auto w = g.pointerWindow.lock()) {
        state.str("pointerWindowId", windowId(w));
        state.str("pointerWindowTitle", w->m_title);
    }
    if (const auto w = g.keyboardWindow.lock()) {
        state.str("keyboardWindowId", windowId(w));
        state.str("keyboardWindowTitle", w->m_title);
        state.boolean("keyboardWindowActive", Desktop::focusState()->isWindowActive(w));
    }
    state.boolean("borrowedActivation", false);
    const auto human = Desktop::focusState()->window();
    state.str("humanFocusWindowId", human ? windowId(human) : "");
    state.num("msSinceHumanInput", double(humanInputAgeMilliseconds()));
    state.num("humanActiveGuardMs", g.humanActiveGuardMs);
    if (g.targetRequested && !usableWindow(g.targetWindow.lock()))
        state.boolean("targetLost", true);
    if (const auto w = g.targetWindow.lock()) {
        state.str("targetWindowId", windowId(w));
        state.str("targetWindowTitle", w->m_title);
    }
    return state.build();
}

std::string windowsJson() {
    // Emitted topmost-first so `stackingIndex` reads as depth, and so each
    // window's occluders are exactly the windows already emitted.
    // windowState()->windows() is bottom-to-top, so walk it backwards.
    struct SStacked {
        std::string id;
        CBox        bounds;
    };
    std::vector<SStacked> covering;
    JsonArr               windows;

    const auto& stacking = Desktop::windowState()->windows();
    int         stackingIndex = 0;
    for (auto it = stacking.rbegin(); it != stacking.rend(); ++it) {
        const PHLWINDOW& w = *it;
        if (!w || !w->m_isMapped)
            continue;

        const std::string id      = windowId(w);
        const CBox        bounds  = windowBounds(w);
        const bool        visible = usableWindow(w);

        // Frame-rect overlap, not true pixel occlusion; overstating the risk
        // is the safe direction.
        JsonArr occludedBy;
        for (const SStacked& above : covering) {
            const bool intersects =
                above.bounds.x < bounds.x + bounds.w && above.bounds.x + above.bounds.w > bounds.x && above.bounds.y < bounds.y + bounds.h && above.bounds.y + above.bounds.h > bounds.y;
            if (intersects)
                occludedBy.str(above.id);
        }

        JsonObj object;
        object.str("id", id)
            .str("title", w->m_title)
            .str("appId", w->m_class)
            .str("resourceClass", w->m_class)
            .num("pid", double(w->getPID()))
            .raw("bounds", rectJson(bounds))
            .boolean("visible", visible)
            // Refined to the real no-focus rule when the keyboard path lands.
            .boolean("focusable", true)
            .boolean("normal", true)
            .boolean("desktop", false)
            .boolean("dock", false)
            // Hyprland has no minimize; a window parked on an invisible
            // workspace already reports `visible: false`.
            .boolean("minimized", false)
            .boolean("active", Desktop::focusState()->isWindowActive(w))
            .num("stackingIndex", stackingIndex)
            .raw("occludedBy", occludedBy.build());
        windows.raw(object.build());
        stackingIndex += 1;
        if (visible)
            covering.push_back({id, bounds});
    }
    return windows.build();
}

bool startSession() {
    if (g.releasedByUser)
        throw sdbus::Error(sdbus::Error::Name{ERR_RELEASED}, std::string("computer control was released with ") + RELEASE_SHORTCUT_LABEL);
    g.running = true;
    g.stopReason.clear();
    // Start where the ghost last was, clamped in case outputs changed.
    const CBox geo = workspaceGeometry();
    if (geo.w > 0 && geo.h > 0) {
        g.pos.x = std::clamp(g.pos.x, geo.x, geo.x + geo.w - 1);
        g.pos.y = std::clamp(g.pos.y, geo.y, geo.y + geo.h - 1);
    }
    setCursorVisible(true);
    g.pointerWindow = windowAtPoint(g.pos);
    noteActivity();
    damageCursorArea();
    return true;
}

bool setIdleTimeout(uint32_t milliseconds) {
    if (milliseconds != 0 && (milliseconds < MIN_IDLE_TIMEOUT_MS || milliseconds > MAX_IDLE_TIMEOUT_MS))
        return false;
    g.idleTimeoutMs = milliseconds;
    armIdleTimer();
    return true;
}

bool setHumanActiveGuardMs(uint32_t milliseconds) {
    if (milliseconds != 0 && (milliseconds < MIN_HUMAN_ACTIVE_GUARD_MS || milliseconds > MAX_HUMAN_ACTIVE_GUARD_MS))
        return false;
    g.humanActiveGuardMs = milliseconds;
    return true;
}

bool setAgentName(const std::string& name) {
    std::string trimmed = name;
    const auto  notSpace = [](unsigned char c) { return !std::isspace(c); };
    trimmed.erase(trimmed.begin(), std::find_if(trimmed.begin(), trimmed.end(), notSpace));
    trimmed.erase(std::find_if(trimmed.rbegin(), trimmed.rend(), notSpace).base(), trimmed.end());
    if (g.agentName == trimmed)
        return true;
    g.agentName      = trimmed;
    g.cursorArtDirty = true;
    if (g.running && g.cursorVisible)
        damageCursorArea();
    return true;
}

bool focusWindow(const std::string& id) {
    if (!requireRunning())
        return false;
    const PHLWINDOW w = findWindowById(id);
    if (!usableWindow(w))
        return false;
    g.targetWindow    = w;
    g.targetRequested = true;
    return true;
}

bool raiseWindow(const std::string& id) {
    if (!requireRunning())
        return false;
    const PHLWINDOW w = findWindowById(id);
    if (!usableWindow(w))
        return false;
    Desktop::windowState()->raise(w);
    return true;
}

bool clearFocusWindow() {
    g.targetWindow.reset();
    g.targetRequested = false;
    return true;
}

bool movePointer(double x, double y) {
    if (!requireRunning())
        return false;
    const CBox geo = workspaceGeometry();
    Vector2D   next{x, y};
    if (geo.w > 0 && geo.h > 0) {
        next.x = std::clamp(next.x, geo.x, geo.x + geo.w - 1);
        next.y = std::clamp(next.y, geo.y, geo.y + geo.h - 1);
    }
    damageCursorArea();
    g.pos = next;
    damageCursorArea();
    g.pointerWindow = windowAtPoint(g.pos);
    return true;
}

// Input injection lands in the next milestone; until then these refuse rather
// than pretend, so the server's probe reports input honestly.
bool injectButton(uint32_t /*button*/, bool /*pressed*/) {
    return false;
}

bool injectAxis(double /*horizontal*/, double /*vertical*/) {
    return false;
}

bool injectKey(uint32_t /*keyCode*/, bool /*pressed*/) {
    return false;
}

std::vector<uint8_t> captureWindow(const std::string& /*windowId*/, uint32_t /*maxDimension*/) {
    throw sdbus::Error(sdbus::Error::Name{ERR_CAPTURE}, "capture is not implemented on hyprland yet");
}

std::vector<uint8_t> captureRegion(int32_t /*x*/, int32_t /*y*/, uint32_t /*width*/, uint32_t /*height*/, uint32_t /*maxDimension*/) {
    throw sdbus::Error(sdbus::Error::Name{ERR_CAPTURE}, "capture is not implemented on hyprland yet");
}

// ---------------------------------------------------------------------------
// D-Bus plumbing: the connection's fds run on Hyprland's Wayland event loop,
// so handlers execute on the compositor thread with no locking.
// ---------------------------------------------------------------------------

int onDbusReadable(int /*fd*/, uint32_t /*mask*/, void* /*data*/) {
    if (!g.dbus)
        return 0;
    while (g.dbus->processPendingEvent())
        ;
    return 0;
}

int onIdleTimer(void* /*data*/) {
    if (!g.running || g.idleTimeoutMs == 0)
        return 0;
    if (idleMilliseconds() >= int64_t(g.idleTimeoutMs))
        stopSession(StopReason::IdleTimeout);
    else
        armIdleTimer();
    return 0;
}

void setupDbus() {
    g.dbus       = sdbus::createSessionBusConnection(sdbus::ServiceName{SERVICE_NAME});
    g.dbusObject = sdbus::createObject(*g.dbus, sdbus::ObjectPath{OBJECT_PATH});

    g.dbusObject
        ->addVTable(sdbus::registerMethod("healthJson").implementedAs([]() { return healthJson(); }),
                    sdbus::registerMethod("stateJson").implementedAs([]() { return stateJson(); }),
                    sdbus::registerMethod("windowsJson").implementedAs([]() { return windowsJson(); }),
                    sdbus::registerMethod("start").implementedAs([]() { return startSession(); }),
                    sdbus::registerMethod("stop").implementedAs([]() {
                        stopSession(StopReason::Request);
                        return true;
                    }),
                    sdbus::registerMethod("setIdleTimeout").implementedAs([](uint32_t ms) { return setIdleTimeout(ms); }),
                    sdbus::registerMethod("setHumanActiveGuardMs").implementedAs([](uint32_t ms) { return setHumanActiveGuardMs(ms); }),
                    sdbus::registerMethod("setAgentName").implementedAs([](const std::string& name) { return setAgentName(name); }),
                    sdbus::registerMethod("focusWindow").implementedAs([](const std::string& id) { return focusWindow(id); }),
                    sdbus::registerMethod("raiseWindow").implementedAs([](const std::string& id) { return raiseWindow(id); }),
                    sdbus::registerMethod("clearFocusWindow").implementedAs([]() { return clearFocusWindow(); }),
                    sdbus::registerMethod("movePointer").implementedAs([](double x, double y) { return movePointer(x, y); }),
                    sdbus::registerMethod("button").implementedAs([](uint32_t button, bool pressed) { return injectButton(button, pressed); }),
                    sdbus::registerMethod("axis").implementedAs([](double horizontal, double vertical) { return injectAxis(horizontal, vertical); }),
                    sdbus::registerMethod("key").implementedAs([](uint32_t keyCode, bool pressed) { return injectKey(keyCode, pressed); }),
                    sdbus::registerMethod("captureWindow").implementedAs([](const std::string& id, uint32_t maxDimension) { return captureWindow(id, maxDimension); }),
                    sdbus::registerMethod("captureRegion").implementedAs([](int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension) {
                        return captureRegion(x, y, width, height, maxDimension);
                    }),
                    sdbus::registerSignal("sessionStopped").withParameters<std::string>("reason"))
        .forInterface(sdbus::InterfaceName{INTERFACE_NAME});

    const auto     poll = g.dbus->getEventLoopPollData();
    wl_event_loop* loop = g_pCompositor->m_wlEventLoop;
    g.dbusFdSource      = wl_event_loop_add_fd(loop, poll.fd, WL_EVENT_READABLE, onDbusReadable, nullptr);
    if (poll.eventFd >= 0)
        g.dbusEvtFdSource = wl_event_loop_add_fd(loop, poll.eventFd, WL_EVENT_READABLE, onDbusReadable, nullptr);
}

// ---------------------------------------------------------------------------
// Human input spy. These EventBus signals fire for the human's real devices;
// the agent's injected events (next milestone) go straight to client resources
// and never pass through the input manager, so the spy cannot see its own
// session's activity.
// ---------------------------------------------------------------------------

void noteHumanInput() {
    g.lastHumanInputMs = nowMs();
}

void setupListeners() {
    g.listeners.renderStage = Event::bus()->m_events.render.stage.listen([](eRenderStage stage) {
        if (stage == RENDER_PRE)
            onRenderPre();
        else if (stage == RENDER_LAST_MOMENT)
            onRenderLastMoment();
    });
    g.listeners.mouseMove = Event::bus()->m_events.input.mouse.move.listen([](const Vector2D&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.mouseButton = Event::bus()->m_events.input.mouse.button.listen([](const IPointer::SButtonEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.mouseAxis = Event::bus()->m_events.input.mouse.axis.listen([](const IPointer::SAxisEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.keyboardKey = Event::bus()->m_events.input.keyboard.key.listen([](const IKeyboard::SKeyEvent& event, Event::SCallbackInfo& info) {
        noteHumanInput();
        if (event.state == WL_KEYBOARD_KEY_STATE_PRESSED)
            g.humanHeldKeys.insert(event.keycode);
        else
            g.humanHeldKeys.erase(event.keycode);

        const bool metaHeld  = g.humanHeldKeys.contains(KEYCODE_LEFTMETA) || g.humanHeldKeys.contains(KEYCODE_RIGHTMETA);
        const bool shiftHeld = g.humanHeldKeys.contains(KEYCODE_LEFTSHIFT) || g.humanHeldKeys.contains(KEYCODE_RIGHTSHIFT);
        if (event.state == WL_KEYBOARD_KEY_STATE_PRESSED && event.keycode == KEYCODE_ESC && metaHeld && shiftHeld) {
            handleReleaseShortcut();
            info.cancelled = true;
        }
    });
}

void teardown() {
    stopSession(StopReason::Request);
    g.listeners.renderStage.reset();
    g.listeners.mouseMove.reset();
    g.listeners.mouseButton.reset();
    g.listeners.mouseAxis.reset();
    g.listeners.keyboardKey.reset();
    if (g.idleTimerSource) {
        wl_event_source_remove(g.idleTimerSource);
        g.idleTimerSource = nullptr;
    }
    if (g.dbusFdSource) {
        wl_event_source_remove(g.dbusFdSource);
        g.dbusFdSource = nullptr;
    }
    if (g.dbusEvtFdSource) {
        wl_event_source_remove(g.dbusEvtFdSource);
        g.dbusEvtFdSource = nullptr;
    }
    g.dbusObject.reset();
    g.dbus.reset();
    g.cursorTex.reset();
    g.badgeTex.reset();
}

} // namespace

// ---------------------------------------------------------------------------
// Plugin entry points
// ---------------------------------------------------------------------------

APICALL EXPORT std::string PLUGIN_API_VERSION() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
    PHANDLE = handle;

    const auto version = HyprlandAPI::getHyprlandVersion(handle);
    g.hyprlandVersion  = version.tag.empty() ? version.hash : version.tag;

    g.lastActivityMs = nowMs();
    // Start the ghost where the human's cursor is, like the KWin plugin does.
    if (g_pInputManager)
        g.pos = g_pInputManager->getMouseCoordsInternal();

    setupListeners();
    try {
        setupDbus();
    } catch (const std::exception& e) {
        // Most likely another Synara computer session owns the bus name. Fail
        // the load loudly rather than run a plugin the server cannot reach.
        teardown();
        throw std::runtime_error(std::string("[synara] D-Bus setup failed: ") + e.what());
    }
    g.idleTimerSource = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onIdleTimer, nullptr);

    return {"synara-computer-use", "Synara computer use (agent seat policy: ghost cursor + direct injection)", "Synara", "0.1"};
}

APICALL EXPORT void PLUGIN_EXIT() {
    teardown();
}
