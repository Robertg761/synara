/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

#pragma once

#include "plugin.h"
#include "scene/item.h"

#include <QDBusContext>
#include <QByteArray>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QMetaObject>
#include <QPointer>
#include <QPointF>
#include <QSet>
#include <QThreadPool>
#include <QTimer>

#include <memory>

class QAction;
struct xkb_state;

namespace KWin
{

class ImageItem;
class LogicalOutput;
class RenderLoop;
class SeatInterface;
class ShapeCursorSource;
class Window;

class SynaraAgentCursorItem : public Item
{
    Q_OBJECT

public:
    explicit SynaraAgentCursorItem(Item *parent);

private:
    void refresh();

    std::unique_ptr<ImageItem> m_imageItem;
    std::unique_ptr<ShapeCursorSource> m_source;
};

class SynaraComputerUsePlugin : public Plugin, public QDBusContext
{
    Q_OBJECT

public:
    explicit SynaraComputerUsePlugin();
    ~SynaraComputerUsePlugin() override;

    Q_INVOKABLE QString healthJson() const;
    Q_INVOKABLE QString stateJson() const;
    Q_INVOKABLE QString windowsJson() const;
    Q_INVOKABLE bool start();
    Q_INVOKABLE bool stop();
    Q_INVOKABLE bool setIdleTimeout(uint milliseconds);
    Q_INVOKABLE bool focusWindow(const QString &windowId);
    Q_INVOKABLE bool clearFocusWindow();
    Q_INVOKABLE bool movePointer(double x, double y);
    Q_INVOKABLE bool button(uint button, bool pressed);
    Q_INVOKABLE bool axis(double horizontal, double vertical);
    Q_INVOKABLE bool key(uint keyCode, bool pressed);
    Q_INVOKABLE QByteArray captureWindow(const QString &windowId, uint maxDimension);
    Q_INVOKABLE QByteArray captureRegion(int x, int y, uint width, uint height, uint maxDimension);

Q_SIGNALS:
    /**
     * Emitted whenever the session ends without the server asking for it, so a
     * live compositor can be diagnosed with `busctl --user monitor`. Reasons:
     * `request`, `idle-timeout`, `user-release`.
     */
    Q_SCRIPTABLE void sessionStopped(const QString &reason);

private:
    struct CaptureRequest;

    enum class StopReason {
        Request,
        IdleTimeout,
        UserRelease,
    };

    static QString toJson(const QJsonObject &object);
    static QString toJson(const QJsonArray &array);
    static QString stopReasonName(StopReason reason);

    void stopSession(StopReason reason);
    void registerReleaseShortcut();
    void handleReleaseShortcut();
    bool requireRunning();
    void noteActivity();
    void armIdleTimer();
    qint64 idleMilliseconds() const;
    void sendButton(quint32 code, bool pressed);
    void sendKey(quint32 keyCode, bool pressed);
    void ensureSeat();
    void ensureCursorItem();
    void setCursorVisible(bool visible);
    QPointF confinedPoint(const QPointF &point) const;
    Window *windowAt(const QPointF &point) const;
    Window *findWindowById(const QString &windowId) const;
    bool usableWindow(const Window *window) const;
    bool updatePointerFocus();
    bool updateKeyboardFocus();
    void releasePressedState();
    void setTimestampNow();
    void syncModifiers();
    void watchRenderLoop(LogicalOutput *output);
    void queueCapture(std::shared_ptr<CaptureRequest> request);
    void scheduleCapture(std::shared_ptr<CaptureRequest> request);
    void handleFrameRequested(RenderLoop *loop);
    void captureAtRenderOpportunity(std::shared_ptr<CaptureRequest> request);
    void finishCapture(std::shared_ptr<CaptureRequest> request, const QByteArray &png, const QString &error);
    void failCapture(std::shared_ptr<CaptureRequest> request, const QString &reason);

    bool m_running = false;
    bool m_releasedByUser = false;
    uint m_idleTimeoutMs;
    QString m_stopReason;
    QTimer m_idleTimer;
    QElapsedTimer m_lastActivity;
    QAction *m_releaseAction = nullptr;
    QPointF m_pos;
    QPointer<Window> m_pointerWindow;
    QPointer<Window> m_keyboardWindow;
    QPointer<Window> m_targetWindow;
    SeatInterface *m_seat = nullptr;
    xkb_state *m_xkbState = nullptr;
    std::unique_ptr<SynaraAgentCursorItem> m_cursorItem;
    QList<quint32> m_pressedKeys;
    QSet<quint32> m_pressedButtons;
    QSet<RenderLoop *> m_renderLoops;
    QSet<RenderLoop *> m_captureFrameLoops;
    QTimer m_captureRenderWatchdog;
    QTimer m_captureEncodeWatchdog;
    std::shared_ptr<CaptureRequest> m_captureRequest;
    QThreadPool m_encodePool;
};

} // namespace KWin
