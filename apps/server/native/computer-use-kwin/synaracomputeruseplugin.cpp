/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

#include "synaracomputeruseplugin.h"
#include "synaracomputerusebuildinfo.h"

#include "core/backendoutput.h"
#include "core/output.h"
#include "core/outputlayer.h"
#include "core/renderloop.h"
#include "core/rendertarget.h"
#include "cursor.h"
#include "cursorsource.h"
#include "effect/effecthandler.h"
#include "input.h"
#include "keyboard_input.h"
#include "opengl/eglcontext.h"
#include "opengl/glframebuffer.h"
#include "opengl/gltexture.h"
#include "scene/scene.h"
#include "pointer_input.h"
#include "scene/imageitem.h"
#include "scene/itemrenderer.h"
#include "scene/workspacescene.h"
#include "utils/cursortheme.h"
#include "wayland/display.h"
#include "wayland/keyboard.h"
#include "wayland/seat.h"
#include "wayland/surface.h"
#include "wayland_server.h"
#include "window.h"
#include "workspace.h"
#include "xkb.h"

#include <QBuffer>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPainter>
#include <QThreadPool>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <limits>
#include <optional>
#include <utility>

namespace KWin
{

static const QString s_service = QStringLiteral("org.synara.ComputerUse");
static const QString s_path = QStringLiteral("/org/synara/ComputerUse");
static const QString s_interface = QStringLiteral("org.synara.ComputerUse1");
static const QString s_build = QStringLiteral(SYNARA_COMPUTER_USE_BUILD_ID);
static const QString s_gitHash = QStringLiteral(SYNARA_COMPUTER_USE_GIT_HASH);
static const QString s_buildTimestamp = QStringLiteral(SYNARA_COMPUTER_USE_BUILD_TIMESTAMP);
static const QString s_kwinVersion = QStringLiteral(SYNARA_COMPUTER_USE_KWIN_VERSION);
static const QString s_agentCursorName = QStringLiteral("synara-agent");
static const QString s_captureErrorName = QStringLiteral("org.synara.ComputerUse.Error.CaptureFailed");
static constexpr int s_captureRenderDeadlineMilliseconds = 2000;
static constexpr int s_captureEncodeDeadlineMilliseconds = 5000;
static constexpr int s_captureMaxNativeSide = 16384;
static constexpr qint64 s_captureMaxNativePixels = 64LL * 1024 * 1024;
static const QString s_captureSizeLimitReason = QStringLiteral("capture exceeds 16384 pixels per side or 64 megapixels");
// The agent gets its own wl_seat so its pointer and keyboard focus are fully
// independent of the user's real seat. Without this the plugin would have to
// time-share the real seat's focus, and concurrent user input would cross
// over (agent keys landing in the user's window and vice versa).
static const QString s_agentSeatName = QStringLiteral("synara-agent");

static QJsonObject pointToJson(const QPointF &point)
{
    return {
        {QStringLiteral("x"), point.x()},
        {QStringLiteral("y"), point.y()},
    };
}

static QJsonObject rectToJson(const RectF &rect)
{
    return {
        {QStringLiteral("x"), rect.x()},
        {QStringLiteral("y"), rect.y()},
        {QStringLiteral("width"), rect.width()},
        {QStringLiteral("height"), rect.height()},
    };
}

struct CapturePart
{
    QImage image;
    QRect destination;
};

class CaptureLayer final : public OutputLayer
{
public:
    CaptureLayer(BackendOutput *output, GLFramebuffer *framebuffer)
        : OutputLayer(output, OutputLayerType::Primary)
        , m_framebuffer(framebuffer)
    {
    }

    DrmDevice *scanoutDevice() const override
    {
        return nullptr;
    }

    FormatModifierMap supportedDrmFormats() const override
    {
        return {};
    }

    void releaseBuffers() override
    {
    }

protected:
    std::optional<OutputLayerBeginFrameInfo> doBeginFrame() override
    {
        if (!m_framebuffer || !m_framebuffer->valid()) {
            return std::nullopt;
        }
        return OutputLayerBeginFrameInfo{
            RenderTarget(m_framebuffer),
            Region(0, 0, m_framebuffer->size().width(), m_framebuffer->size().height()),
        };
    }

    bool doEndFrame(const Region &, const Region &, OutputFrame *) override
    {
        return true;
    }

private:
    GLFramebuffer *const m_framebuffer;
};

class CaptureEncodeTask final : public QRunnable
{
public:
    explicit CaptureEncodeTask(std::function<void()> work)
        : m_work(std::move(work))
    {
        setAutoDelete(true);
    }

    void run() override
    {
        m_work();
    }

private:
    std::function<void()> m_work;
};

static std::optional<QSize> deviceSize(const RectF &rect, qreal scale)
{
    if (!std::isfinite(scale) || scale <= 0 || rect.isEmpty()) {
        return std::nullopt;
    }

    const qreal width = std::ceil(rect.width() * scale);
    const qreal height = std::ceil(rect.height() * scale);
    if (!std::isfinite(width) || !std::isfinite(height)
        || width < 1 || height < 1
        || width > std::numeric_limits<int>::max()
        || height > std::numeric_limits<int>::max()) {
        return std::nullopt;
    }
    return QSize(int(width), int(height));
}

static QRect deviceDestination(const RectF &part, const RectF &target, qreal scale, const QSize &targetSize)
{
    const auto roundedEdge = [&](qreal coordinate, qreal targetCoordinate, int limit) {
        return qBound(0, qRound((coordinate - targetCoordinate) * scale), limit);
    };

    // Round shared logical edges once, then derive each size from its edges.
    // Adjacent output parts therefore meet at the same device coordinate.
    const int left = part.left() <= target.left() ? 0 : roundedEdge(part.left(), target.left(), targetSize.width());
    const int top = part.top() <= target.top() ? 0 : roundedEdge(part.top(), target.top(), targetSize.height());
    const int right = part.right() >= target.right() ? targetSize.width() : roundedEdge(part.right(), target.left(), targetSize.width());
    const int bottom = part.bottom() >= target.bottom() ? targetSize.height() : roundedEdge(part.bottom(), target.top(), targetSize.height());
    if (right <= left || bottom <= top) {
        return {};
    }
    return QRect(left, top, right - left, bottom - top).intersected(QRect(0, 0, targetSize.width(), targetSize.height()));
}

static bool captureSizeWithinLimits(const QSize &size)
{
    return size.width() > 0
        && size.height() > 0
        && size.width() <= s_captureMaxNativeSide
        && size.height() <= s_captureMaxNativeSide
        && qint64(size.width()) * qint64(size.height()) <= s_captureMaxNativePixels;
}

static bool isWindowVisibleForCapture(const Window *window)
{
    return window
        && !window->isDeleted()
        && window->isOnCurrentActivity()
        && window->isOnCurrentDesktop()
        && !window->isMinimized()
        && !window->isHidden()
        && !window->isHiddenByShowDesktop();
}

static QByteArray encodeCapture(const QList<CapturePart> &parts, const QSize &nativeSize, qreal effectiveScale, uint maxDimension, QString *error)
{
    if (parts.isEmpty() || !nativeSize.isValid()) {
        *error = QStringLiteral("capture produced no pixels");
        return {};
    }

    QImage image(nativeSize, QImage::Format_RGBA8888_Premultiplied);
    if (image.isNull()) {
        *error = QStringLiteral("capture image allocation failed");
        return {};
    }
    image.fill(Qt::transparent);

    QPainter painter(&image);
    painter.setCompositionMode(QPainter::CompositionMode_Source);
    for (const CapturePart &part : parts) {
        if (part.image.isNull() || !part.destination.isValid()) {
            continue;
        }
        painter.save();
        painter.translate(part.destination.x(), part.destination.y() + part.destination.height());
        painter.scale(1, -1);
        painter.drawImage(QRect(0, 0, part.destination.width(), part.destination.height()), part.image);
        painter.restore();
    }
    painter.end();

    image.setDevicePixelRatio(effectiveScale);

    if (maxDimension > 0) {
        const qint64 largest = std::max(image.width(), image.height());
        if (largest > maxDimension) {
            const qreal factor = qreal(maxDimension) / qreal(largest);
            const QSize scaledSize(
                qMax(1, qRound(image.width() * factor)),
                qMax(1, qRound(image.height() * factor)));
            image = image.scaled(scaledSize, Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
            if (image.isNull()) {
                *error = QStringLiteral("capture downscale failed");
                return {};
            }
            image.setDevicePixelRatio(effectiveScale * factor);
        }
    }

    image.setText(QStringLiteral("SynaraCaptureScale"), QString::number(effectiveScale, 'f', 3));
    image = image.convertToFormat(QImage::Format_RGBA8888);
    if (image.isNull()) {
        *error = QStringLiteral("PNG image conversion failed");
        return {};
    }

    QByteArray png;
    QBuffer buffer(&png);
    if (!buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "PNG")) {
        *error = QStringLiteral("PNG encoding failed");
        return {};
    }
    return png;
}

struct SynaraComputerUsePlugin::CaptureRequest
{
    CaptureRequest(const QDBusConnection &connection, const QDBusMessage &message)
        : connection(connection)
        , message(message)
    {
    }

    QDBusConnection connection;
    QDBusMessage message;
    QPointer<Window> window;
    QMetaObject::Connection windowDestroyedConnection;
    RectF region;
    uint maxDimension = 0;
    bool windowCapture = false;
    std::atomic_bool renderStarted = false;
    std::atomic_bool finished = false;
};

static bool renderCapturePart(WorkspaceScene *scene,
                              EglContext *context,
                              LogicalOutput *output,
                              const RectF &viewport,
                              Window *selectedWindow,
                              bool windowCapture,
                              Item *agentCursorItem,
                              QImage *image,
                              QString *error)
{
    BackendOutput *backendOutput = output ? output->backendOutput() : nullptr;
    if (!scene || !context || !output || !backendOutput) {
        *error = QStringLiteral("render unavailable");
        return false;
    }

    const std::optional<QSize> nativeSize = deviceSize(viewport, output->scale());
    if (!nativeSize) {
        *error = QStringLiteral("capture dimensions are invalid");
        return false;
    }

    std::unique_ptr<GLTexture> texture = GLTexture::allocate(GL_RGBA8, *nativeSize);
    if (!texture || texture->isNull()) {
        *error = QStringLiteral("offscreen texture allocation failed");
        return false;
    }
    auto framebuffer = std::make_unique<GLFramebuffer>(texture.get());
    if (!framebuffer->valid()) {
        *error = QStringLiteral("offscreen framebuffer allocation failed");
        return false;
    }

    CaptureLayer layer(backendOutput, framebuffer.get());
    if (!layer.preparePresentationTest()) {
        *error = QStringLiteral("render unavailable");
        return false;
    }
    const std::optional<OutputLayerBeginFrameInfo> frame = layer.beginFrame();
    if (!frame) {
        *error = QStringLiteral("render unavailable");
        return false;
    }

    SceneView view(scene, output, backendOutput, &layer);
    view.setViewport(viewport);
    view.setScale(output->scale());
    view.addWindowFilter([selectedWindow, windowCapture](Window *window) {
        if (!window || window->excludeFromCapture()) {
            return true;
        }
        return windowCapture && window != selectedWindow;
    });

    std::unique_ptr<ItemTreeView> cursorView;
    if (Item *cursorItem = scene->cursorItem()) {
        cursorView = std::make_unique<ItemTreeView>(&view, cursorItem, output, backendOutput, &layer);
        // setExclusive(true) already registers with the SceneView; registering again
        // would leave a dangling entry after ~ItemTreeView's single removeOne.
        cursorView->setExclusive(true);
    }
    std::unique_ptr<ItemTreeView> agentCursorView;
    if (agentCursorItem) {
        agentCursorView = std::make_unique<ItemTreeView>(&view, agentCursorItem, output, backendOutput, &layer);
        agentCursorView->setExclusive(true);
    }

    view.prePaint();
    view.paint(frame->renderTarget, QPoint(), Region(0, 0, nativeSize->width(), nativeSize->height()));
    view.postPaint();
    if (!layer.endFrame(Region(), Region(), nullptr)) {
        *error = QStringLiteral("offscreen frame submission failed");
        return false;
    }

    QImage readback(*nativeSize, QImage::Format_RGBA8888_Premultiplied);
    if (readback.isNull()) {
        *error = QStringLiteral("capture readback allocation failed");
        return false;
    }
    GLFramebuffer::pushFramebuffer(framebuffer.get());
    context->glReadnPixels(0,
                           0,
                           nativeSize->width(),
                           nativeSize->height(),
                           GL_RGBA,
                           GL_UNSIGNED_BYTE,
                           static_cast<GLsizei>(readback.sizeInBytes()),
                           readback.bits());
    GLFramebuffer::popFramebuffer();
    *image = std::move(readback);
    return true;
}

SynaraAgentCursorItem::SynaraAgentCursorItem(Item *parent)
    : Item(parent)
{
    m_source = std::make_unique<ShapeCursorSource>();
    m_source->setTheme(input()->pointer()->cursorTheme());
    m_source->setShape(Qt::ArrowCursor);

    refresh();
    connect(m_source.get(), &CursorSource::changed, this, &SynaraAgentCursorItem::refresh);
}

void SynaraAgentCursorItem::refresh()
{
    // KWin 6.7 removed ItemRenderer::createImageItem(); ImageItem now has a
    // public constructor. This mirrors KWin's own CursorItem::refresh().
    if (!m_imageItem) {
        m_imageItem = std::make_unique<ImageItem>(this);
    }
    m_imageItem->setImage(m_source->image());
    m_imageItem->setPosition(-m_source->hotspot());
    m_imageItem->setSize(m_source->image().deviceIndependentSize());
}

SynaraComputerUsePlugin::SynaraComputerUsePlugin()
    : Plugin()
    , m_pos(Cursors::self()->mouse()->pos())
{
    m_encodePool.setMaxThreadCount(1);

    m_captureRenderWatchdog.setSingleShot(true);
    connect(&m_captureRenderWatchdog, &QTimer::timeout, this, [this]() {
        if (m_captureRequest) {
            failCapture(m_captureRequest, QStringLiteral("capture render timeout"));
        }
    });
    m_captureEncodeWatchdog.setSingleShot(true);
    connect(&m_captureEncodeWatchdog, &QTimer::timeout, this, [this]() {
        if (m_captureRequest) {
            failCapture(m_captureRequest, QStringLiteral("capture encode timeout"));
        }
    });

    ensureSeat();
    ensureCursorItem();
    setCursorVisible(false);

    if (effects) {
        for (LogicalOutput *output : effects->screens()) {
            watchRenderLoop(output);
        }
        connect(effects, &EffectsHandler::screenAdded, this, [this](LogicalOutput *output) {
            watchRenderLoop(output);
        });
    }

    QDBusConnection::sessionBus().registerService(s_service);
    QDBusConnection::sessionBus().registerObject(s_path, s_interface, this, QDBusConnection::ExportAllInvokables);
}

SynaraComputerUsePlugin::~SynaraComputerUsePlugin()
{
    m_encodePool.waitForDone();
    if (m_captureRequest) {
        failCapture(m_captureRequest, QStringLiteral("capture canceled: plugin destroyed"));
    }
    releasePressedState();
    if (m_seat) {
        m_seat->notifyPointerLeave();
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
    if (m_xkbState) {
        xkb_state_unref(m_xkbState);
        m_xkbState = nullptr;
    }
    QDBusConnection::sessionBus().unregisterObject(s_path);
    QDBusConnection::sessionBus().unregisterService(s_service);
}

QString SynaraComputerUsePlugin::toJson(const QJsonObject &object)
{
    return QString::fromUtf8(QJsonDocument(object).toJson(QJsonDocument::Compact));
}

QString SynaraComputerUsePlugin::toJson(const QJsonArray &array)
{
    return QString::fromUtf8(QJsonDocument(array).toJson(QJsonDocument::Compact));
}

QString SynaraComputerUsePlugin::healthJson() const
{
    QJsonObject health{
        {QStringLiteral("ok"), bool(m_seat)},
        {QStringLiteral("running"), m_running},
        {QStringLiteral("service"), s_service},
        {QStringLiteral("path"), s_path},
        {QStringLiteral("interface"), s_interface},
        {QStringLiteral("build"), s_build},
        {QStringLiteral("gitHash"), s_gitHash},
        {QStringLiteral("buildTimestamp"), s_buildTimestamp},
        {QStringLiteral("kwinVersion"), s_kwinVersion},
        {QStringLiteral("seat"), s_agentSeatName},
        {QStringLiteral("dedicatedSeat"), true},
        {QStringLiteral("overlay"), bool(m_cursorItem)},
        {QStringLiteral("workspace"), Workspace::self() != nullptr},
        {QStringLiteral("effects"), effects != nullptr},
        {QStringLiteral("capture"), effects && effects->isOpenGLCompositing() && effects->openglContext()},
    };
    if (Workspace::self()) {
        health.insert(QStringLiteral("workspaceGeometry"),
                     rectToJson(RectF(Workspace::self()->geometry())));
    }
    return toJson(health);
}

QString SynaraComputerUsePlugin::stateJson() const
{
    QJsonObject state{
        {QStringLiteral("running"), m_running},
        {QStringLiteral("seat"), s_agentSeatName},
        {QStringLiteral("dedicatedSeat"), true},
        {QStringLiteral("position"), pointToJson(m_pos)},
        {QStringLiteral("pressedButtonCount"), m_pressedButtons.size()},
        {QStringLiteral("pressedKeyCount"), m_pressedKeys.size()},
    };
    if (m_pointerWindow) {
        state.insert(QStringLiteral("pointerWindowId"), m_pointerWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("pointerWindowTitle"), m_pointerWindow->caption());
    }
    if (m_keyboardWindow) {
        state.insert(QStringLiteral("keyboardWindowId"), m_keyboardWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("keyboardWindowTitle"), m_keyboardWindow->caption());
    }
    if (m_targetWindow) {
        state.insert(QStringLiteral("targetWindowId"), m_targetWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("targetWindowTitle"), m_targetWindow->caption());
    }
    return toJson(state);
}

QString SynaraComputerUsePlugin::windowsJson() const
{
    QJsonArray windows;
    if (!Workspace::self()) {
        return toJson(windows);
    }

    const QList<Window *> stacking = Workspace::self()->stackingOrder();
    for (Window *window : stacking) {
        if (!window || window->isDeleted() || !window->isClient()) {
            continue;
        }

        const bool visible = usableWindow(window);
        QJsonObject object{
            {QStringLiteral("id"), window->internalId().toString(QUuid::WithoutBraces)},
            {QStringLiteral("title"), window->caption()},
            {QStringLiteral("appId"), window->desktopFileName().isEmpty() ? window->resourceClass() : window->desktopFileName()},
            {QStringLiteral("resourceClass"), window->resourceClass()},
            {QStringLiteral("pid"), int(window->pid())},
            {QStringLiteral("bounds"), rectToJson(window->frameGeometry())},
            {QStringLiteral("visible"), visible},
            {QStringLiteral("focusable"), window->wantsInput()},
            {QStringLiteral("normal"), window->isNormalWindow()},
            {QStringLiteral("desktop"), window->isDesktop()},
            {QStringLiteral("dock"), window->isDock()},
            {QStringLiteral("minimized"), window->isMinimized()},
        };
        windows.append(object);
    }
    return toJson(windows);
}

bool SynaraComputerUsePlugin::start()
{
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    m_running = true;
    setCursorVisible(true);
    movePointer(m_pos.x(), m_pos.y());
    return true;
}

bool SynaraComputerUsePlugin::stop()
{
    if (m_captureRequest) {
        failCapture(m_captureRequest, QStringLiteral("capture canceled by stop"));
    }
    releasePressedState();
    if (m_seat) {
        m_seat->notifyPointerLeave();
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
    m_pointerWindow.clear();
    m_keyboardWindow.clear();
    m_running = false;
    setCursorVisible(false);
    return true;
}

bool SynaraComputerUsePlugin::focusWindow(const QString &windowId)
{
    Window *window = findWindowById(windowId);
    if (!usableWindow(window)) {
        return false;
    }
    m_targetWindow = window;
    updatePointerFocus();
    updateKeyboardFocus();
    return true;
}

bool SynaraComputerUsePlugin::clearFocusWindow()
{
    m_targetWindow.clear();
    updatePointerFocus();
    updateKeyboardFocus();
    return true;
}

bool SynaraComputerUsePlugin::movePointer(double x, double y)
{
    ensureSeat();
    if (!m_seat) {
        return false;
    }

    m_pos = confinedPoint(QPointF(x, y));
    ensureCursorItem();
    if (m_cursorItem) {
        m_cursorItem->setPosition(m_pos);
    }

    setTimestampNow();
    updatePointerFocus();
    m_seat->notifyPointerFrame();
    return true;
}

bool SynaraComputerUsePlugin::button(uint button, bool pressed)
{
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    if (!updatePointerFocus()) {
        return false;
    }
    updateKeyboardFocus();

    const auto state = pressed ? PointerButtonState::Pressed : PointerButtonState::Released;
    if (pressed) {
        m_pressedButtons.insert(button);
    } else {
        m_pressedButtons.remove(button);
    }

    setTimestampNow();
    m_seat->notifyPointerButton(button, state);
    m_seat->notifyPointerFrame();
    return true;
}

bool SynaraComputerUsePlugin::axis(double horizontal, double vertical)
{
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    if (!updatePointerFocus()) {
        return false;
    }

    setTimestampNow();
    if (horizontal != 0) {
        m_seat->notifyPointerAxis(Qt::Horizontal, horizontal * 15.0 / 120.0, int(horizontal), PointerAxisSource::Wheel);
    }
    if (vertical != 0) {
        m_seat->notifyPointerAxis(Qt::Vertical, vertical * 15.0 / 120.0, int(vertical), PointerAxisSource::Wheel);
    }
    m_seat->notifyPointerFrame();
    return true;
}

bool SynaraComputerUsePlugin::key(uint keyCode, bool pressed)
{
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    if (!updateKeyboardFocus()) {
        return false;
    }

    const auto state = pressed ? KeyboardKeyState::Pressed : KeyboardKeyState::Released;
    if (pressed) {
        if (!m_pressedKeys.contains(keyCode)) {
            m_pressedKeys.append(keyCode);
        }
    } else {
        m_pressedKeys.removeOne(keyCode);
    }

    setTimestampNow();
    // Delivered on the agent's own seat, never through KWin's real keyboard
    // pipeline, so the user's focus and typing are untouched.
    m_seat->notifyKeyboardKey(keyCode, state, waylandServer()->display()->nextSerial());
    if (m_xkbState) {
        // evdev keycode -> xkb keycode offset is 8.
        xkb_state_update_key(m_xkbState, keyCode + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
        syncModifiers();
    }
    return true;
}

QByteArray SynaraComputerUsePlugin::captureWindow(const QString &windowId, uint maxDimension)
{
    if (!calledFromDBus()) {
        return {};
    }
    setDelayedReply(true);

    auto request = std::make_shared<CaptureRequest>(connection(), message());
    request->window = findWindowById(windowId);
    request->maxDimension = maxDimension;
    request->windowCapture = true;
    queueCapture(request);
    return {};
}

QByteArray SynaraComputerUsePlugin::captureRegion(int x, int y, uint width, uint height, uint maxDimension)
{
    if (!calledFromDBus()) {
        return {};
    }
    setDelayedReply(true);

    auto request = std::make_shared<CaptureRequest>(connection(), message());
    request->region = RectF(qreal(x), qreal(y), qreal(width), qreal(height));
    request->maxDimension = maxDimension;
    queueCapture(request);
    return {};
}

void SynaraComputerUsePlugin::watchRenderLoop(LogicalOutput *output)
{
    if (!output || !output->backendOutput()) {
        return;
    }
    RenderLoop *loop = output->backendOutput()->renderLoop();
    if (!loop || m_renderLoops.contains(loop)) {
        return;
    }

    m_renderLoops.insert(loop);
    connect(loop, &QObject::destroyed, this, [this, loop]() {
        m_renderLoops.remove(loop);
        m_captureFrameLoops.remove(loop);
    });
}

void SynaraComputerUsePlugin::queueCapture(std::shared_ptr<CaptureRequest> request)
{
    if (!request) {
        return;
    }
    if (m_captureRequest) {
        failCapture(request, QStringLiteral("capture already in flight"));
        return;
    }
    m_captureRequest = request;

    Workspace *workspace = Workspace::self();
    if (!workspace) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    if (request->windowCapture) {
        Window *window = request->window.data();
        if (!window || window->isDeleted()) {
            failCapture(request, QStringLiteral("unknown window"));
            return;
        }
        if (!isWindowVisibleForCapture(window)) {
            failCapture(request, QStringLiteral("window not visible"));
            return;
        }
        if (window->excludeFromCapture()) {
            failCapture(request, QStringLiteral("window excluded from capture"));
            return;
        }
        if (!window->surface() || !window->surface()->isMapped() || !window->windowItem() || !window->readyForPainting()) {
            failCapture(request, QStringLiteral("window unavailable"));
            return;
        }
        request->region = window->frameGeometry();
    }

    request->region = request->region.intersected(RectF(workspace->geometry()));
    if (request->region.isEmpty()) {
        failCapture(request, request->windowCapture ? QStringLiteral("window not visible") : QStringLiteral("zero-size region"));
        return;
    }

    if (request->windowCapture) {
        Window *window = request->window.data();
        request->windowDestroyedConnection = connect(window, &QObject::destroyed, this, [this, request]() {
            if (m_captureRequest == request) {
                failCapture(request, QStringLiteral("window closed during capture"));
            }
        });
    }

    if (!effects || !effects->scene() || !effects->isOpenGLCompositing() || !effects->openglContext()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    bool hasOutput = false;
    qreal effectiveScale = 1.0;
    QSet<RenderLoop *> captureLoops;
    for (LogicalOutput *output : workspace->outputs()) {
        if (!output || !output->backendOutput()) {
            continue;
        }
        watchRenderLoop(output);
        RenderLoop *loop = output->backendOutput()->renderLoop();
        if (!loop) {
            continue;
        }
        const RectF viewport = request->region.intersected(output->geometryF());
        if (viewport.isEmpty()) {
            continue;
        }
        hasOutput = true;
        effectiveScale = std::max(effectiveScale, output->scale());
        captureLoops.insert(loop);
    }
    if (!hasOutput) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    const std::optional<QSize> nativeSize = deviceSize(request->region, effectiveScale);
    if (!nativeSize) {
        failCapture(request, QStringLiteral("capture dimensions are invalid"));
        return;
    }
    if (!captureSizeWithinLimits(*nativeSize)) {
        failCapture(request, s_captureSizeLimitReason);
        return;
    }

    for (RenderLoop *loop : std::as_const(captureLoops)) {
        if (m_captureFrameLoops.contains(loop)) {
            continue;
        }
        connect(loop, &RenderLoop::frameRequested, this, &SynaraComputerUsePlugin::handleFrameRequested, Qt::DirectConnection);
        m_captureFrameLoops.insert(loop);
    }

    m_captureRenderWatchdog.start(s_captureRenderDeadlineMilliseconds);
    scheduleCapture(std::move(request));
}

void SynaraComputerUsePlugin::scheduleCapture(std::shared_ptr<CaptureRequest> request)
{
    if (!Workspace::self()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    for (LogicalOutput *output : Workspace::self()->outputs()) {
        if (!output || !output->backendOutput() || !output->backendOutput()->renderLoop()) {
            continue;
        }
        if (!request->region.intersects(output->geometryF())) {
            continue;
        }
        output->backendOutput()->renderLoop()->scheduleRepaint();
    }
}

void SynaraComputerUsePlugin::handleFrameRequested(RenderLoop *loop)
{
    Q_UNUSED(loop)
    if (!m_captureRequest || m_captureRequest->finished.load() || m_captureRequest->renderStarted.exchange(true)) {
        return;
    }

    captureAtRenderOpportunity(m_captureRequest);
}

void SynaraComputerUsePlugin::captureAtRenderOpportunity(std::shared_ptr<CaptureRequest> request)
{
    if (!request || m_captureRequest != request || request->finished.load()) {
        return;
    }

    Window *selectedWindow = request->window.data();
    if (request->windowCapture) {
        if (!selectedWindow || selectedWindow->isDeleted()) {
            failCapture(request, QStringLiteral("window closed during capture"));
            return;
        }
        if (!isWindowVisibleForCapture(selectedWindow)) {
            failCapture(request, QStringLiteral("window not visible"));
            return;
        }
        if (selectedWindow->excludeFromCapture()) {
            failCapture(request, QStringLiteral("window excluded from capture"));
            return;
        }
        if (!selectedWindow->surface() || !selectedWindow->surface()->isMapped() || !selectedWindow->windowItem() || !selectedWindow->readyForPainting()) {
            failCapture(request, QStringLiteral("window unavailable"));
            return;
        }
        request->region = selectedWindow->frameGeometry();
    }

    Workspace *workspace = Workspace::self();
    if (!workspace) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }
    request->region = request->region.intersected(RectF(workspace->geometry()));
    if (request->region.isEmpty()) {
        failCapture(request, request->windowCapture ? QStringLiteral("window not visible") : QStringLiteral("zero-size region"));
        return;
    }
    if (!effects || !effects->scene() || !effects->isOpenGLCompositing()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }
    if (!effects->makeOpenGLContextCurrent() || !effects->openglContext()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    struct OutputCapture
    {
        LogicalOutput *output;
        RectF viewport;
    };
    QList<OutputCapture> outputs;
    qreal effectiveScale = 1.0;
    for (LogicalOutput *output : workspace->outputs()) {
        if (!output || !output->backendOutput() || !output->backendOutput()->renderLoop()) {
            continue;
        }
        const RectF viewport = request->region.intersected(output->geometryF());
        if (viewport.isEmpty()) {
            continue;
        }
        outputs.append({output, viewport});
        effectiveScale = std::max(effectiveScale, output->scale());
    }
    if (outputs.isEmpty()) {
        failCapture(request, QStringLiteral("render unavailable"));
        return;
    }

    const std::optional<QSize> nativeSize = deviceSize(request->region, effectiveScale);
    if (!nativeSize) {
        failCapture(request, QStringLiteral("capture dimensions are invalid"));
        return;
    }
    if (!captureSizeWithinLimits(*nativeSize)) {
        failCapture(request, s_captureSizeLimitReason);
        return;
    }

    QList<CapturePart> parts;
    for (const OutputCapture &output : std::as_const(outputs)) {
        QImage image;
        QString error;
        if (!renderCapturePart(effects->scene(),
                               effects->openglContext(),
                               output.output,
                               output.viewport,
                               selectedWindow,
                               request->windowCapture,
                               m_cursorItem.get(),
                               &image,
                               &error)) {
            failCapture(request, error);
            return;
        }
        parts.append({std::move(image), deviceDestination(output.viewport, request->region, effectiveScale, *nativeSize)});
    }

    QPointer<SynaraComputerUsePlugin> receiver(this);
    const uint maxDimension = request->maxDimension;
    m_captureRenderWatchdog.stop();
    m_captureEncodeWatchdog.start(s_captureEncodeDeadlineMilliseconds);
    m_encodePool.start(new CaptureEncodeTask(
        [receiver, request, parts = std::move(parts), nativeSize = *nativeSize, effectiveScale, maxDimension]() mutable {
            QString error;
            const QByteArray png = encodeCapture(parts, nativeSize, effectiveScale, maxDimension, &error);
            if (!receiver) {
                return;
            }
            QMetaObject::invokeMethod(receiver.data(),
                                      [receiver, request, png, error]() {
                                          if (receiver) {
                                              receiver->finishCapture(request, png, error);
                                          }
                                      },
                                      Qt::QueuedConnection);
        }));
}

void SynaraComputerUsePlugin::finishCapture(std::shared_ptr<CaptureRequest> request, const QByteArray &png, const QString &error)
{
    if (!request || m_captureRequest != request || request->finished.exchange(true)) {
        return;
    }

    m_captureRenderWatchdog.stop();
    m_captureEncodeWatchdog.stop();
    for (RenderLoop *loop : std::as_const(m_captureFrameLoops)) {
        QObject::disconnect(loop, &RenderLoop::frameRequested, this, &SynaraComputerUsePlugin::handleFrameRequested);
    }
    m_captureFrameLoops.clear();
    QObject::disconnect(request->windowDestroyedConnection);
    request->windowDestroyedConnection = {};
    m_captureRequest.reset();

    QString reason = error.simplified();
    if (reason.isEmpty() && png.isEmpty()) {
        reason = QStringLiteral("capture failed");
    }
    if (!reason.isEmpty()) {
        request->connection.send(request->message.createErrorReply(s_captureErrorName, reason));
        return;
    }
    if (png.isEmpty()) {
        request->connection.send(request->message.createErrorReply(s_captureErrorName, QStringLiteral("capture produced no PNG")));
        return;
    }
    request->connection.send(request->message.createReply(QVariant::fromValue(png)));
}

void SynaraComputerUsePlugin::failCapture(std::shared_ptr<CaptureRequest> request, const QString &reason)
{
    if (!request) {
        return;
    }
    if (m_captureRequest == request) {
        finishCapture(std::move(request), {}, reason);
        return;
    }
    if (!request->finished.exchange(true)) {
        QObject::disconnect(request->windowDestroyedConnection);
        request->windowDestroyedConnection = {};
        request->connection.send(request->message.createErrorReply(s_captureErrorName, reason.simplified()));
    }
}

void SynaraComputerUsePlugin::ensureSeat()
{
    if (m_seat || !waylandServer() || !waylandServer()->display()) {
        return;
    }

    m_seat = new SeatInterface(waylandServer()->display(), s_agentSeatName, this);
    m_seat->setHasPointer(true);
    m_seat->setHasKeyboard(true);

    // Mirror the real keyboard's keymap onto the agent seat so clients can
    // interpret our evdev keycodes, and track xkb state locally so modifier
    // events (shift, ctrl, ...) are correct for the agent's own key stream.
    if (input() && input()->keyboard() && input()->keyboard()->xkb()) {
        if (xkb_keymap *keymap = input()->keyboard()->xkb()->keymap()) {
            if (char *content = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1)) {
                m_seat->keyboard()->setKeymap(QByteArray(content));
                free(content);
            }
            m_xkbState = xkb_state_new(keymap);
        }
    }
    m_seat->keyboard()->setRepeatInfo(25, 660);
}

void SynaraComputerUsePlugin::ensureCursorItem()
{
    if (m_cursorItem || !effects || !effects->scene()) {
        return;
    }

    m_cursorItem = std::make_unique<SynaraAgentCursorItem>(effects->scene()->overlayItem());
    m_cursorItem->setZ(1000);
    m_cursorItem->setPosition(m_pos);
    m_cursorItem->setVisible(m_running);
}

void SynaraComputerUsePlugin::setCursorVisible(bool visible)
{
    ensureCursorItem();
    if (m_cursorItem) {
        m_cursorItem->setVisible(visible);
    }
}

QPointF SynaraComputerUsePlugin::confinedPoint(const QPointF &point) const
{
    if (!Workspace::self()) {
        return point;
    }
    LogicalOutput *output = Workspace::self()->outputAt(point);
    if (!output) {
        return point;
    }
    const RectF geometry = output->geometryF();
    return QPointF(std::clamp(point.x(), geometry.x(), geometry.x() + geometry.width() - 1),
                   std::clamp(point.y(), geometry.y(), geometry.y() + geometry.height() - 1));
}

Window *SynaraComputerUsePlugin::windowAt(const QPointF &point) const
{
    if (!Workspace::self()) {
        return nullptr;
    }

    const QList<Window *> stacking = Workspace::self()->stackingOrder();
    auto it = stacking.end();
    while (it != stacking.begin()) {
        --it;
        Window *window = *it;
        if (!usableWindow(window)) {
            continue;
        }
        if (window->hitTest(point)) {
            return window;
        }
    }
    return nullptr;
}

Window *SynaraComputerUsePlugin::findWindowById(const QString &windowId) const
{
    if (!Workspace::self()) {
        return nullptr;
    }
    return Workspace::self()->findWindow([&windowId](const Window *window) {
        return window->internalId().toString(QUuid::WithoutBraces) == windowId
            || window->internalId().toString() == windowId;
    });
}

bool SynaraComputerUsePlugin::usableWindow(const Window *window) const
{
    return window
        && !window->isDeleted()
        && window->isClient()
        && window->surface()
        && window->surface()->isMapped()
        && window->isOnCurrentActivity()
        && window->isOnCurrentDesktop()
        && !window->isMinimized()
        && !window->isHidden()
        && !window->isHiddenByShowDesktop()
        && window->readyForPainting()
        && window->wantsInput();
}

bool SynaraComputerUsePlugin::updatePointerFocus()
{
    Window *window = nullptr;
    if (usableWindow(m_targetWindow) && m_targetWindow->hitTest(m_pos)) {
        window = m_targetWindow;
    } else {
        window = windowAt(m_pos);
    }

    if (!window) {
        if (m_pointerWindow && m_seat) {
            m_seat->notifyPointerLeave();
        }
        m_pointerWindow.clear();
        return false;
    }

    if (m_pointerWindow == window) {
        m_seat->notifyPointerMotion(m_pos);
        return true;
    }

    if (m_pointerWindow) {
        m_seat->notifyPointerLeave();
    }
    m_pointerWindow = window;
    m_seat->notifyPointerEnter(window->surface(), m_pos, window->inputTransformation());
    return true;
}

bool SynaraComputerUsePlugin::updateKeyboardFocus()
{
    Window *window = nullptr;
    if (usableWindow(m_targetWindow)) {
        window = m_targetWindow;
    } else if (usableWindow(m_pointerWindow)) {
        window = m_pointerWindow;
    } else {
        window = windowAt(m_pos);
    }

    if (!window || !m_seat) {
        return false;
    }
    if (m_keyboardWindow == window) {
        return true;
    }

    m_keyboardWindow = window;
    m_seat->setFocusedKeyboardSurface(window->surface(), m_pressedKeys);
    return true;
}

void SynaraComputerUsePlugin::releasePressedState()
{
    if (!m_seat) {
        return;
    }

    const auto buttons = m_pressedButtons.values();
    for (quint32 button : buttons) {
        this->button(button, false);
    }
    const auto keys = m_pressedKeys;
    for (auto it = keys.crbegin(); it != keys.crend(); ++it) {
        this->key(*it, false);
    }
}

void SynaraComputerUsePlugin::setTimestampNow()
{
    if (!m_seat) {
        return;
    }
    m_seat->setTimestamp(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()));
}

void SynaraComputerUsePlugin::syncModifiers()
{
    if (!m_seat || !m_xkbState) {
        return;
    }
    m_seat->notifyKeyboardModifiers(
        xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_DEPRESSED),
        xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_LATCHED),
        xkb_state_serialize_mods(m_xkbState, XKB_STATE_MODS_LOCKED),
        xkb_state_serialize_layout(m_xkbState, XKB_STATE_LAYOUT_EFFECTIVE));
}

} // namespace KWin

#include "moc_synaracomputeruseplugin.cpp"
