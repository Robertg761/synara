package com.synara.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.os.Bundle
import android.os.Parcel
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.math.roundToInt

/** One unprivileged guest renderer. No Capacitor bridge, auth headers, or app assets enter it. */
internal class BrowserGuestHost(
    private val context: Context,
    private val appView: WebView,
    private val emit: (JSObject) -> Unit,
) {
    private data class Tab(
        val id: String = UUID.randomUUID().toString(),
        var url: String = "about:blank",
        var title: String = "New tab",
        var loading: Boolean = false,
        var back: Boolean = false,
        var forward: Boolean = false,
        var error: String? = null,
        var history: Bundle? = null,
    )
    private data class Workspace(
        val id: String,
        val tabs: MutableList<Tab> = mutableListOf(),
        var active: String? = null,
        var open: Boolean = false,
        var version: Long = 0,
    )
    private val workspaces = BrowserWorkspaceCache<Workspace>(16, 32, { it.tabs.size }) { workspace ->
        if (owner === workspace) { owner = null; bounds = null }
        workspace.tabs.clear()
        workspace.active = null
        workspace.open = false
        changed(workspace)
    }
    private var guest: WebView? = null
    private var owner: Workspace? = null
    private var current: Tab? = null
    private var bounds: JSObject? = null
    private var viewportWidth = 0.0
    private var foreground = true
    private var revision = System.currentTimeMillis() * 1000

    fun execute(operation: String, input: JSObject): JSObject {
        if (operation == "reset") {
            destroy()
            revision += 1
            return JSObject()
        }
        val id = input.optString("threadId")
        require(id.isNotBlank() && id.length <= 256) { "A browser thread is required." }
        require(operation in setOf(
            "open", "close", "hide", "getState", "setPanelBounds", "navigate", "newTab",
            "selectTab", "closeTab", "reload", "goBack", "goForward", "captureScreenshot",
        )) { "Unsupported browser operation." }
        when (operation) {
            "open" -> requireUrl(input.optString("initialUrl", "about:blank"))
            "navigate" -> requireUrl(input.optString("url"))
            "newTab" -> requireUrl(input.optString("url", "about:blank"))
        }
        val existing = workspaces[id]
        if (existing == null) {
            when (operation) {
                // A missed eviction event must still supersede the client's last open state.
                "getState", "close" -> return snapshot(Workspace(id, version = revision))
                "hide", "setPanelBounds" -> return JSObject()
                "open", "navigate", "newTab" -> Unit
                else -> throw IllegalArgumentException("The browser tab is no longer available.")
            }
        }
        val workspace = existing ?: workspaces.getOrCreate(id, displayedWorkspaceIds()) { Workspace(id) }
        if (operation !in setOf("getState", "hide", "setPanelBounds")) workspaces.touch(id)
        fun selected(): Tab = workspace.tabs.find { it.id == input.optString("tabId", workspace.active ?: "") }
            ?: throw IllegalArgumentException("The browser tab is no longer available.")
        when (operation) {
            "open" -> {
                val initial = input.optString("initialUrl", "about:blank")
                requireUrl(initial)
                if (workspace.tabs.isEmpty()) addTab(workspace, initial, true)
                else if (input.has("initialUrl")) {
                    val tab = workspace.tabs.first { it.id == workspace.active }
                    tab.url = initial; tab.error = null; tab.history = null
                    if (current === tab) guest?.loadUrl(initial)
                }
                workspace.open = true
                if (owner !== workspace) {
                    releaseGuest()
                    owner = workspace
                    bounds = null
                }
                // Bounds arrive from the shared panel after it mounts.
            }
            "close" -> {
                if (owner === workspace) { releaseGuest(); owner = null; bounds = null }
                workspace.tabs.clear()
                workspace.active = null
                workspace.open = false
                changed(workspace)
                workspaces.remove(id)
                return snapshot(workspace)
            }
            "hide" -> if (owner === workspace) { bounds = null; releaseGuest() }
            "getState" -> return snapshot(workspace)
            "setPanelBounds" -> {
                if (owner !== workspace || !workspace.open) return JSObject()
                val next = input.optJSONObject("bounds")
                viewportWidth = input.optDouble("viewportWidth", 0.0)
                require(viewportWidth.isFinite() && viewportWidth > 0) { "Invalid browser viewport." }
                if (next != null) {
                    val values = listOf("x", "y", "width", "height").map { next.optDouble(it) }
                    require(values.all { it.isFinite() } && values[2] >= 0 && values[3] >= 0) { "Invalid browser bounds." }
                }
                bounds = next?.let { JSObject(it.toString()) }
                if (bounds == null) guest?.visibility = View.INVISIBLE else showSelected(workspace)
                return JSObject()
            }
            "navigate" -> {
                val url = input.optString("url")
                requireUrl(url)
                if (workspace.tabs.isEmpty()) addTab(workspace, url, true)
                val tab = selected()
                tab.url = url; tab.error = null; tab.history = null
                workspace.active = tab.id
                if (owner === workspace) {
                    if (current === tab && guest != null) guest!!.loadUrl(url)
                    else showSelected(workspace)
                }
            }
            "newTab" -> {
                val url = input.optString("url", "about:blank")
                requireUrl(url)
                addTab(workspace, url, input.optBoolean("activate", true))
                if (owner === workspace) showSelected(workspace)
            }
            "selectTab" -> { workspace.active = selected().id; if (owner === workspace) showSelected(workspace) }
            "closeTab" -> {
                val tab = selected()
                if (current === tab) releaseGuest()
                workspace.tabs.remove(tab)
                if (workspace.active == tab.id) workspace.active = workspace.tabs.firstOrNull()?.id
                if (workspace.tabs.isEmpty()) addTab(workspace, "about:blank", true)
                if (owner === workspace) showSelected(workspace)
            }
            "reload", "goBack", "goForward" -> {
                val tab = selected()
                require(owner === workspace && workspace.active == tab.id) { "Open this tab before navigating." }
                tab.error = null
                showSelected(workspace)
                when (operation) {
                    "reload" -> guest?.reload()
                    "goBack" -> if (guest?.canGoBack() == true) guest?.goBack()
                    "goForward" -> if (guest?.canGoForward() == true) guest?.goForward()
                }
            }
            "captureScreenshot" -> {
                require(current === selected() && owner === workspace) { "Open this tab before capturing it." }
                return capture()
            }
            else -> throw IllegalArgumentException("Unsupported browser operation.")
        }
        changed(workspace)
        return snapshot(workspace)
    }

    private fun requireUrl(url: String) {
        require(BrowserUrlPolicy.allows(url)) { "Use an HTTPS page address. Local app pages cannot open here." }
    }

    private fun displayedWorkspaceIds(): Set<String> =
        if (guest != null) setOfNotNull(owner?.id) else emptySet()

    private fun addTab(workspace: Workspace, url: String, activate: Boolean) {
        workspaces.reserveTab(displayedWorkspaceIds() + workspace.id)
        val tab = Tab(url = url)
        workspace.tabs.add(tab)
        if (activate || workspace.active == null) workspace.active = tab.id
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showSelected(workspace: Workspace) {
        val rect = bounds ?: return
        val tab = workspace.tabs.find { it.id == workspace.active } ?: return
        // Bounds are CSS pixels relative to the trusted WebView's viewport, not screen pixels.
        val scale = appView.width / viewportWidth
        val x = rect.optDouble("x"); val y = rect.optDouble("y")
        val width = rect.optDouble("width"); val height = rect.optDouble("height")
        require(listOf(x, y, width, height, scale).all { it.isFinite() }) { "Invalid browser bounds." }
        val left = (x * scale).roundToInt().coerceIn(0, appView.width)
        val top = (y * scale).roundToInt().coerceIn(0, appView.height)
        val right = ((x + width) * scale).roundToInt().coerceIn(left, appView.width)
        val bottom = ((y + height) * scale).roundToInt().coerceIn(top, appView.height)
        if (guest == null || current !== tab) {
            releaseGuest()
            owner = workspace
            current = tab
            val view = WebView(context)
            guest = view
            view.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                mediaPlaybackRequiresUserGesture = true
            }
            view.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val blocked = !BrowserUrlPolicy.allows(request.url.toString())
                    if (blocked && request.isForMainFrame && guest === view) {
                        tab.error = "This browser supports HTTPS pages only."
                        changed(workspace)
                    }
                    return blocked
                }
                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    if (guest !== view) return
                    tab.loading = true; tab.error = null
                    if (url != null && BrowserUrlPolicy.allows(url)) tab.url = url
                    changed(workspace)
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (guest !== view) return
                    tab.loading = false
                    tab.back = view.canGoBack(); tab.forward = view.canGoForward()
                    if (url != null && BrowserUrlPolicy.allows(url)) tab.url = url
                    changed(workspace)
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (guest !== view || !request.isForMainFrame) return
                    tab.loading = false; tab.error = "The page could not be loaded. Check its address and connection."
                    changed(workspace)
                }
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    handler.cancel()
                    if (guest !== view) return
                    tab.loading = false; tab.error = "The page has an invalid HTTPS certificate."
                    changed(workspace)
                }
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    if (guest === view) {
                        releaseGuest(saveHistory = false)
                        tab.error = "The browser stopped. Reload the page to continue."
                        changed(workspace)
                    } else { (view.parent as? ViewGroup)?.removeView(view); view.destroy() }
                    return true
                }
            }
            view.webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) {
                    if (guest !== view) return
                    tab.title = title?.take(256)?.takeIf { it.isNotBlank() } ?: "Browser"
                    changed(workspace)
                }
            }
            view.setDownloadListener { _, _, _, _, _ ->
                if (guest === view) {
                    tab.error = "To download this file, open the page in your external browser."
                    changed(workspace)
                }
            }
            (appView.parent as ViewGroup).addView(view, ViewGroup.LayoutParams(1, 1))
            val saved = tab.history
            tab.history = null
            if (saved == null || view.restoreState(saved) == null) view.loadUrl(tab.url)
        }
        guest?.apply {
            translationX = (appView.left + left).toFloat()
            translationY = (appView.top + top).toFloat()
            layoutParams = layoutParams.apply { this.width = right - left; this.height = bottom - top }
            visibility = if (this@BrowserGuestHost.foreground && right > left && bottom > top) View.VISIBLE else View.INVISIBLE
        }
    }

    private fun releaseGuest(saveHistory: Boolean = true) {
        val view = guest ?: return
        guest = null
        if (saveHistory) {
            val saved = Bundle()
            view.saveState(saved)
            val parcel = Parcel.obtain()
            try {
                parcel.writeBundle(saved)
                current?.history = if (parcel.dataSize() <= 256 * 1024) saved else null
            } finally { parcel.recycle() }
        }
        current?.loading = false
        current = null
        (view.parent as? ViewGroup)?.removeView(view)
        view.stopLoading()
        view.destroy()
    }

    private fun capture(): JSObject {
        val view = guest ?: throw IllegalStateException("Open a page before capturing it.")
        require(view.width > 0 && view.height > 0) { "Show the page before capturing it." }
        val scale = minOf(1.0, 1600.0 / maxOf(view.width, view.height))
        val bitmap = Bitmap.createBitmap(maxOf(1, (view.width * scale).toInt()), maxOf(1, (view.height * scale).toInt()), Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(bitmap)
            canvas.scale(scale.toFloat(), scale.toFloat())
            view.draw(canvas)
            val output = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            return JSObject().put("name", "browser-${System.currentTimeMillis()}.png")
                .put("base64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
        } finally { bitmap.recycle() }
    }

    private fun snapshot(workspace: Workspace): JSObject = JSObject()
        .put("threadId", workspace.id).put("version", workspace.version).put("open", workspace.open)
        .put("activeTabId", workspace.active ?: JSONObject.NULL)
        .put("lastError", JSONObject.NULL)
        .put("tabs", JSArray(workspace.tabs.map { tab ->
            JSObject().put("id", tab.id).put("url", tab.url).put("title", tab.title)
                .put("runtimeSurface", "native").put("status", if (current === tab) "live" else "suspended")
                .put("isLoading", tab.loading).put("canGoBack", tab.back).put("canGoForward", tab.forward)
                .put("faviconUrl", JSONObject.NULL).put("lastCommittedUrl", tab.url)
                .put("lastError", tab.error ?: JSONObject.NULL)
        }.toTypedArray()))

    private fun changed(workspace: Workspace) { workspace.version = ++revision; emit(snapshot(workspace)) }
    fun pause() { foreground = false; guest?.onPause(); guest?.visibility = View.INVISIBLE }
    fun resume() { foreground = true; guest?.onResume(); owner?.let { if (bounds != null) showSelected(it) } }
    fun destroy() { releaseGuest(false); owner = null; bounds = null; workspaces.clear() }
}
