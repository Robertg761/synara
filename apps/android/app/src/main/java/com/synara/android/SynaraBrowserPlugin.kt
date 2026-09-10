package com.synara.android

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** The RPC endpoint exists only on the trusted app WebView, never on a guest page. */
@CapacitorPlugin(name = "SynaraBrowser")
class SynaraBrowserPlugin : Plugin() {
    private var host: BrowserGuestHost? = null

    @PluginMethod
    fun execute(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val browser = host ?: BrowserGuestHost(context, bridge.webView) {
                    notifyListeners("state", it)
                }.also { host = it }
                call.resolve(browser.execute(call.getString("operation") ?: "", call.getObject("input") ?: JSObject()))
            } catch (error: IllegalArgumentException) {
                call.reject(error.message ?: "Invalid browser request.")
            } catch (_: Exception) {
                call.reject("The browser operation could not be completed.")
            }
        }
    }

    override fun handleOnPause() { host?.pause() }
    override fun handleOnResume() { host?.resume() }
    override fun handleOnDestroy() { host?.destroy(); host = null }
}
