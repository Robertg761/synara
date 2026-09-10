package com.synara.android

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.getcapacitor.JSObject
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeShellInsetsTest {
    @Test fun nativeInsetsStayOwnedAfterViewportCoverAndHandleCutoutAndKeyboard() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val container = activity.bridge.webView.parent as View
                // Simulate SystemBars learning viewport-fit=cover on a modern WebView.
                // Its CSS listener must be disabled; otherwise it removes native top padding.
                val plugin = activity.bridge.getPlugin("SystemBars").instance
                assertEquals("disable", plugin.javaClass.getDeclaredField("insetsHandling").apply { isAccessible = true }.get(plugin))
                plugin.javaClass.getDeclaredField("hasViewportCover").apply { isAccessible = true }.setBoolean(plugin, true)
                fun dispatch(bars: Insets, cutout: Insets, ime: Insets) {
                    val input = WindowInsetsCompat.Builder()
                        .setInsets(WindowInsetsCompat.Type.systemBars(), bars)
                        .setInsets(WindowInsetsCompat.Type.displayCutout(), cutout)
                        .setInsets(WindowInsetsCompat.Type.ime(), ime)
                        .setVisible(WindowInsetsCompat.Type.ime(), ime.bottom > 0)
                        .build()
                    val output = ViewCompat.dispatchApplyWindowInsets(container, input)
                    assertEquals(maxOf(bars.top, cutout.top), container.paddingTop)
                    assertEquals(maxOf(bars.left, cutout.left), container.paddingLeft)
                    assertEquals(maxOf(bars.bottom, cutout.bottom, ime.bottom), container.paddingBottom)
                    assertEquals(Insets.NONE, output.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()))
                }
                dispatch(Insets.of(0, 72, 0, 48), Insets.NONE, Insets.NONE)
                dispatch(Insets.of(0, 48, 0, 24), Insets.of(96, 0, 0, 0), Insets.of(0, 0, 0, 640))
                dispatch(Insets.of(0, 72, 0, 48), Insets.NONE, Insets.NONE)
                val parent = container as ViewGroup
                fun layout() {
                    parent.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY))
                    parent.layout(0, 0, 1080, 1920)
                }
                layout()
                assertEquals(72, activity.bridge.webView.top)
                val host = BrowserGuestHost(activity, activity.bridge.webView) {}
                try {
                    host.execute("open", JSObject().put("threadId", "inset-alignment"))
                    host.execute("setPanelBounds", JSObject().put("threadId", "inset-alignment")
                        .put("viewportWidth", activity.bridge.webView.width)
                        .put("bounds", JSObject().put("x", 24).put("y", 120).put("width", 400).put("height", 600)))
                    layout()
                    val guest = (0 until parent.childCount).map { parent.getChildAt(it) }
                        .filterIsInstance<WebView>().first { it !== activity.bridge.webView }
                    assertEquals(activity.bridge.webView.top + 120, guest.y.toInt())
                    assertEquals(activity.bridge.webView.left + 24, guest.x.toInt())
                } finally { host.destroy() }
            }
        }
    }
}
