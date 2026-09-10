package com.synara.android

import android.content.res.Configuration
import android.graphics.Color
import android.view.View
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.synara.android.data.SecureSessionStore

/** Device capabilities only. No Synara RPCs, transcript parsing, or feature state belong here. */
@CapacitorPlugin(name = "SynaraShell")
class SynaraShellPlugin : Plugin() {
    private var shellBackgroundColor: Int? = null

    @PluginMethod
    fun setBackgroundColor(call: PluginCall) {
        val value = call.getString("color")
        if (value == null || !Regex("#[0-9a-fA-F]{6}").matches(value)) {
            call.reject("Expected an opaque RGB background color.")
            return
        }
        val color = Color.parseColor(value)
        activity.runOnUiThread {
            shellBackgroundColor = color
            applyShellBackground()
            call.resolve()
        }
    }

    @Suppress("DEPRECATION")
    private fun applyShellBackground() {
        val color = shellBackgroundColor ?: return
        activity.window.decorView.setBackgroundColor(color)
        (bridge.webView.parent as? View)?.setBackgroundColor(color)
        // Older Android versions paint the bars separately from the edge-to-edge decor.
        activity.window.statusBarColor = color
        activity.window.navigationBarColor = color
    }

    override fun handleOnConfigurationChanged(newConfig: Configuration) {
        super.handleOnConfigurationChanged(newConfig)
        // The bundled SystemBars plugin resets decor from the OS theme during this callback.
        // Post after all plugin callbacks, regardless of their iteration order.
        activity.window.decorView.post { applyShellBackground() }
    }

    private val sessions by lazy { SecureSessionStore(context) }

    @PluginMethod
    fun consumeLaunchUrl(call: PluginCall) {
        activity.runOnUiThread {
            val intent = activity.intent
            val url = intent?.dataString
            val expected = call.getString("expectedUrl")
            val result = JSObject()
            if (url != null && (expected == null || expected == url)) {
                result.put("url", url)
                // A renderer reload after pairing must not replay the one-use credential.
                intent.data = null
            }
            call.resolve(result)
        }
    }

    @PluginMethod
    fun getSession(call: PluginCall) {
        try {
            val session = sessions.readSession()
            val result = JSObject()
            if (session != null && SessionPolicy.isValid(session.baseUrl, session.sessionToken)) {
                result.put("serverUrl", session.baseUrl)
                result.put("sessionToken", session.sessionToken)
            }
            call.resolve(result)
        } catch (error: Exception) {
            call.reject("Could not read the saved connection.", error)
        }
    }

    @PluginMethod
    fun setSession(call: PluginCall) {
        val serverUrl = call.getString("serverUrl")
        val token = call.getString("sessionToken")
        if (!SessionPolicy.isValid(serverUrl, token)) {
            call.reject("Use an HTTPS server address and a non-empty session token.")
            return
        }
        try {
            sessions.saveSession(serverUrl!!, token!!)
            call.resolve()
        } catch (error: Exception) {
            call.reject("Could not save the connection securely.", error)
        }
    }

    @PluginMethod
    fun clearSession(call: PluginCall) {
        try {
            sessions.clearAll()
            call.resolve()
        } catch (error: Exception) {
            call.reject("Could not remove the saved connection.", error)
        }
    }
}
