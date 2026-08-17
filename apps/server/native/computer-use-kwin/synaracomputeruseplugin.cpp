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

#include <KGlobalAccel>

#include <QAction>
#include <QBuffer>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeySequence>
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
static const QString s_releasedErrorName = QStringLiteral("org.synara.ComputerUse.Error.ControlReleased");
// A dead server must never leave the agent seat alive, so the session's
// deadline lives here rather than in the server that may have crashed.
static constexpr uint s_defaultIdleTimeoutMs = 5 * 60 * 1000;
static constexpr uint s_minIdleTimeoutMs = 1000;
static constexpr uint s_maxIdleTimeoutMs = 60 * 60 * 1000;
static const QString s_releaseActionName = QStringLiteral("SynaraReleaseComputerControl");
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

// Meta+Shift+Esc is unused by stock Plasma (kill-window is Ctrl+Alt+Esc) and
// mirrors the muscle memory of Ctrl+Shift+Esc elsewhere. The user's real seat
// feeds KWin's shortcut handling, and agent input never enters that pipeline,
// so the agent can neither trigger nor swallow this combination.
static QKeySequence releaseShortcut()
{
    return QKeySequence(QKeyCombination(Qt::MetaModifier | Qt::ShiftModifier, Qt::Key_Escape));
}

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
    , m_idleTimeoutMs(s_defaultIdleTimeoutMs)
    , m_pos(Cursors::self()->mouse()->pos())
{
    m_encodePool.setMaxThreadCount(1);

    m_lastActivity.start();
    m_idleTimer.setSingleShot(true);
    m_idleTimer.setTimerType(Qt::CoarseTimer);
    connect(&m_idleTimer, &QTimer::timeout, this, [this]() {
        stopSession(StopReason::IdleTimeout);
    });
    registerReleaseShortcut();

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
    QDBusConnection::sessionBus().registerObject(s_path,
                                                 s_interface,
                                                 this,
                                                 QDBusConnection::ExportAllInvokables | QDBusConnection::ExportScriptableSignals);
}

SynaraComputerUsePlugin::~SynaraComputerUsePlugin()
{
    m_idleTimer.stop();
    m_encodePool.waitForDone();
    if (m_captureRequest) {
        failCapture(m_captureRequest, QStringLiteral("capture canceled: plugin destroyed"));
    }
    releasePressedState();
    if (m_seat) {
        m_seat->notifyPointerLeave();
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
    clearWindowActivation();
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
        {QStringLiteral("idleTimeoutMs"), double(m_idleTimeoutMs)},
        {QStringLiteral("releasedByUser"), m_releasedByUser},
        {QStringLiteral("releaseShortcut"), releaseShortcut().toString(QKeySequence::NativeText)},
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
        {QStringLiteral("idleTimeoutMs"), double(m_idleTimeoutMs)},
        {QStringLiteral("idleMs"), double(idleMilliseconds())},
        {QStringLiteral("releasedByUser"), m_releasedByUser},
        {QStringLiteral("releaseShortcut"), releaseShortcut().toString(QKeySequence::NativeText)},
    };
    if (m_running && m_idleTimeoutMs > 0) {
        state.insert(QStringLiteral("idleRemainingMs"),
                     double(std::max<qint64>(0, qint64(m_idleTimeoutMs) - idleMilliseconds())));
    }
    if (!m_stopReason.isEmpty()) {
        state.insert(QStringLiteral("stopReason"), m_stopReason);
    }
    if (m_pointerWindow) {
        state.insert(QStringLiteral("pointerWindowId"), m_pointerWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("pointerWindowTitle"), m_pointerWindow->caption());
    }
    if (m_keyboardWindow) {
        state.insert(QStringLiteral("keyboardWindowId"), m_keyboardWindow->internalId().toString(QUuid::WithoutBraces));
        state.insert(QStringLiteral("keyboardWindowTitle"), m_keyboardWindow->caption());
        state.insert(QStringLiteral("keyboardWindowActive"), m_keyboardWindow->isActive());
    }
    // True while the agent, rather than the compositor, is the reason the focused
    // window reports itself active to its client.
    state.insert(QStringLiteral("borrowedActivation"), !m_activatedWindow.isNull());
    if (m_targetRequested && !usableWindow(m_targetWindow)) {
        state.insert(QStringLiteral("targetLost"), true);
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

    // Emitted topmost-first so `stackingIndex` reads as depth, and so each
    // window's occluders are exactly the windows already emitted. A coordinate
    // click lands on whatever is topmost at that point, so the agent cannot
    // choose a target safely without knowing what covers it.
    struct StackedWindow
    {
        QString id;
        RectF bounds;
    };
    QList<StackedWindow> covering;

    const QList<Window *> stacking = Workspace::self()->stackingOrder();
    int stackingIndex = 0;
    for (auto it = stacking.crbegin(); it != stacking.crend(); ++it) {
        Window *window = *it;
        if (!window || window->isDeleted() || !window->isClient()) {
            continue;
        }

        const QString id = window->internalId().toString(QUuid::WithoutBraces);
        const RectF bounds = window->frameGeometry();
        const bool visible = usableWindow(window);

        // Frame-rect overlap, not true pixel occlusion: a window above may be
        // translucent or shaped. Overstating the risk is the safe direction,
        // because the remedy is scoping the click to a window either way.
        QJsonArray occludedBy;
        for (const StackedWindow &above : std::as_const(covering)) {
            if (above.bounds.intersects(bounds)) {
                occludedBy.append(above.id);
            }
        }

        QJsonObject object{
            {QStringLiteral("id"), id},
            {QStringLiteral("title"), window->caption()},
            {QStringLiteral("appId"), window->desktopFileName().isEmpty() ? window->resourceClass() : window->desktopFileName()},
            {QStringLiteral("resourceClass"), window->resourceClass()},
            {QStringLiteral("pid"), int(window->pid())},
            {QStringLiteral("bounds"), rectToJson(bounds)},
            {QStringLiteral("visible"), visible},
            {QStringLiteral("focusable"), window->wantsInput()},
            {QStringLiteral("normal"), window->isNormalWindow()},
            {QStringLiteral("desktop"), window->isDesktop()},
            {QStringLiteral("dock"), window->isDock()},
            {QStringLiteral("minimized"), window->isMinimized()},
            // Toolkits gate shortcut dispatch on this, not on keyboard focus, so
            // the agent has to be able to see it before blaming a lost hotkey on
            // the input path.
            {QStringLiteral("active"), window->isActive()},
            {QStringLiteral("stackingIndex"), stackingIndex},
            {QStringLiteral("occludedBy"), occludedBy},
        };
        windows.append(object);
        stackingIndex += 1;
        if (visible) {
            covering.append({id, bounds});
        }
    }
    return toJson(windows);
}

bool SynaraComputerUsePlugin::start()
{
    if (m_releasedByUser) {
        if (calledFromDBus()) {
            sendErrorReply(s_releasedErrorName,
                           QStringLiteral("computer control was released with %1")
                               .arg(releaseShortcut().toString(QKeySequence::NativeText)));
        }
        return false;
    }
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    m_running = true;
    m_stopReason.clear();
    setCursorVisible(true);
    movePointer(m_pos.x(), m_pos.y());
    noteActivity();
    return true;
}

bool SynaraComputerUsePlugin::stop()
{
    stopSession(StopReason::Request);
    return true;
}

bool SynaraComputerUsePlugin::setIdleTimeout(uint milliseconds)
{
    if (milliseconds != 0 && (milliseconds < s_minIdleTimeoutMs || milliseconds > s_maxIdleTimeoutMs)) {
        return false;
    }
    m_idleTimeoutMs = milliseconds;
    armIdleTimer();
    return true;
}

void SynaraComputerUsePlugin::stopSession(StopReason reason)
{
    m_idleTimer.stop();
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
    m_targetWindow.clear();
    m_targetRequested = false;
    clearWindowActivation();

    const bool wasRunning = m_running;
    const bool latching = reason == StopReason::UserRelease;
    const bool changed = wasRunning || (latching && !m_releasedByUser);
    m_running = false;
    setCursorVisible(false);
    m_stopReason = stopReasonName(reason);
    // Only the human's panic switch latches. An idle timeout is routine, and an
    // explicit server stop ends the session the server itself owns, so both
    // leave the next start() free to run.
    m_releasedByUser = latching;

    if (changed) {
        Q_EMIT sessionStopped(m_stopReason);
    }
}

QString SynaraComputerUsePlugin::stopReasonName(StopReason reason)
{
    switch (reason) {
    case StopReason::IdleTimeout:
        return QStringLiteral("idle-timeout");
    case StopReason::UserRelease:
        return QStringLiteral("user-release");
    case StopReason::Request:
        break;
    }
    return QStringLiteral("request");
}

void SynaraComputerUsePlugin::registerReleaseShortcut()
{
    m_releaseAction = new QAction(this);
    m_releaseAction->setObjectName(s_releaseActionName);
    m_releaseAction->setText(QStringLiteral("Release Synara computer control"));
    connect(m_releaseAction, &QAction::triggered, this, &SynaraComputerUsePlugin::handleReleaseShortcut);
    KGlobalAccel::setGlobalShortcut(m_releaseAction, releaseShortcut());
}

void SynaraComputerUsePlugin::handleReleaseShortcut()
{
    // Pressing it again hands control back without a trip through Synara, so a
    // panic stop can never strand the feature.
    if (!m_running && m_releasedByUser) {
        m_releasedByUser = false;
        m_stopReason = QStringLiteral("user-resume");
        return;
    }
    stopSession(StopReason::UserRelease);
}

bool SynaraComputerUsePlugin::requireRunning()
{
    if (!m_running) {
        return false;
    }
    noteActivity();
    return true;
}

void SynaraComputerUsePlugin::noteActivity()
{
    m_lastActivity.restart();
    armIdleTimer();
}

void SynaraComputerUsePlugin::armIdleTimer()
{
    if (!m_running || m_idleTimeoutMs == 0) {
        m_idleTimer.stop();
        return;
    }
    m_idleTimer.start(int(std::max<qint64>(0, qint64(m_idleTimeoutMs) - idleMilliseconds())));
}

qint64 SynaraComputerUsePlugin::idleMilliseconds() const
{
    return m_lastActivity.isValid() ? m_lastActivity.elapsed() : 0;
}

bool SynaraComputerUsePlugin::focusWindow(const QString &windowId)
{
    if (!requireRunning()) {
        return false;
    }
    Window *window = findWindowById(windowId);
    if (!usableWindow(window)) {
        return false;
    }
    m_targetWindow = window;
    m_targetRequested = true;
    updatePointerFocus();
    updateKeyboardFocus();
    return true;
}

bool SynaraComputerUsePlugin::raiseWindow(const QString &windowId)
{
    if (!requireRunning()) {
        return false;
    }
    Window *window = findWindowById(windowId);
    if (!usableWindow(window)) {
        return false;
    }
    // Restack only. `activateWindow` would move the human's keyboard focus,
    // and the agent already has its own seat, so raising is the whole point:
    // it makes the window the agent is driving the one the user can see.
    Workspace::self()->raiseWindow(window);
    return true;
}

bool SynaraComputerUsePlugin::clearFocusWindow()
{
    if (!requireRunning()) {
        return false;
    }
    m_targetWindow.clear();
    m_targetRequested = false;
    updatePointerFocus();
    updateKeyboardFocus();
    return true;
}

bool SynaraComputerUsePlugin::movePointer(double x, double y)
{
    if (!requireRunning()) {
        return false;
    }
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
    if (!requireRunning()) {
        return false;
    }
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    if (!updatePointerFocus()) {
        return false;
    }
    updateKeyboardFocus();

    sendButton(button, pressed);
    return true;
}

bool SynaraComputerUsePlugin::axis(double horizontal, double vertical)
{
    if (!requireRunning()) {
        return false;
    }
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
    if (!requireRunning()) {
        return false;
    }
    ensureSeat();
    if (!m_seat) {
        return false;
    }
    if (!updateKeyboardFocus()) {
        return false;
    }

    sendKey(keyCode, pressed);
    return true;
}

void SynaraComputerUsePlugin::sendButton(quint32 code, bool pressed)
{
    if (!m_seat) {
        return;
    }
    if (pressed) {
        m_pressedButtons.insert(code);
    } else {
        m_pressedButtons.remove(code);
    }

    setTimestampNow();
    m_seat->notifyPointerButton(code, pressed ? PointerButtonState::Pressed : PointerButtonState::Released);
    m_seat->notifyPointerFrame();
}

void SynaraComputerUsePlugin::sendKey(quint32 keyCode, bool pressed)
{
    if (!m_seat) {
        return;
    }
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
    m_seat->notifyKeyboardKey(keyCode,
                              pressed ? KeyboardKeyState::Pressed : KeyboardKeyState::Released,
                              waylandServer()->display()->nextSerial());
    if (m_xkbState) {
        // evdev keycode -> xkb keycode offset is 8.
        xkb_state_update_key(m_xkbState, keyCode + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
        syncModifiers();
    }
}

QByteArray SynaraComputerUsePlugin::captureWindow(const QString &windowId, uint maxDimension)
{
    if (!calledFromDBus()) {
        return {};
    }
    setDelayedReply(true);
    if (m_running) {
        noteActivity();
    }

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
    if (m_running) {
        noteActivity();
    }

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
    if (m_targetRequested) {
        // An explicit target that has gone away has to fail loudly. Silently
        // falling back to whatever sits under the ghost cursor is how a Ctrl+Q
        // aimed at a closing window ends up quitting an unrelated one, and it
        // reads to the caller as input being delivered late.
        if (!usableWindow(m_targetWindow)) {
            forgetPressedKeys();
            clearKeyboardFocus();
            return false;
        }
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
        updateWindowActivation(window);
        return true;
    }

    // Keys still held while focus migrates must be released on the surface that
    // saw the press. Handing the pressed-key array to the next surface makes that
    // client believe the agent is holding Ctrl, and then delivers it the orphaned
    // release, so a half-finished chord leaks into an unrelated window.
    releasePressedKeys();

    m_keyboardWindow = window;
    m_seat->setFocusedKeyboardSurface(window->surface(), m_pressedKeys);
    updateWindowActivation(window);
    return true;
}

void SynaraComputerUsePlugin::clearKeyboardFocus()
{
    m_keyboardWindow.clear();
    clearWindowActivation();
    if (m_seat) {
        m_seat->setFocusedKeyboardSurface(nullptr);
    }
}

void SynaraComputerUsePlugin::updateWindowActivation(Window *window)
{
    if (m_activatedWindow == window) {
        return;
    }
    clearWindowActivation();
    if (!window || !m_running) {
        return;
    }
    // Toolkits do not derive "this window is active" from wl_keyboard focus: Qt
    // tracks the xdg_toplevel `activated` state, and its shortcut matcher refuses
    // to match anything while the application has no active window. Without this,
    // the agent's keystrokes reach the focus widget (text still types) but every
    // QAction shortcut is dropped.
    //
    // Window::setActive() is the narrow tool for that: it flips the window's
    // activation state, and therefore the `activated` flag the client sees, while
    // deliberately leaving the compositor's keyboard focus alone. The human's seat
    // keeps typing wherever it was.
    if (Workspace::self() && Workspace::self()->activeWindow() == window) {
        return;
    }
    window->setActive(true);
    m_activatedWindow = window;
}

void SynaraComputerUsePlugin::clearWindowActivation()
{
    Window *window = m_activatedWindow;
    m_activatedWindow.clear();
    if (!window || window->isDeleted()) {
        return;
    }
    // KWin may have handed the window real activation in the meantime; that state
    // is the compositor's to own, so only undo activation we invented ourselves.
    if (Workspace::self() && Workspace::self()->activeWindow() == window) {
        return;
    }
    window->setActive(false);
}

void SynaraComputerUsePlugin::releasePressedKeys()
{
    const auto keys = m_pressedKeys;
    for (auto it = keys.crbegin(); it != keys.crend(); ++it) {
        sendKey(*it, false);
    }
}

void SynaraComputerUsePlugin::forgetPressedKeys()
{
    if (m_pressedKeys.isEmpty()) {
        return;
    }
    // The surface that saw the presses is gone, so no release can land there.
    // Drop the keys locally instead, or the next window the agent focuses inherits
    // a phantom Ctrl through the enter event's pressed-key array.
    const auto keys = m_pressedKeys;
    m_pressedKeys.clear();
    if (!m_xkbState) {
        return;
    }
    for (auto it = keys.crbegin(); it != keys.crend(); ++it) {
        xkb_state_update_key(m_xkbState, *it + 8, XKB_KEY_UP);
    }
    syncModifiers();
}

void SynaraComputerUsePlugin::releasePressedState()
{
    if (!m_seat) {
        return;
    }

    // Bypasses the public entry points: a release must land even when the
    // session is already stopping, and it must never re-target focus.
    const auto buttons = m_pressedButtons.values();
    for (quint32 button : buttons) {
        sendButton(button, false);
    }
    releasePressedKeys();
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
