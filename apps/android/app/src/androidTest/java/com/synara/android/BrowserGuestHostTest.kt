package com.synara.android

import android.graphics.BitmapFactory
import android.graphics.Color
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.JSObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Pass -e browserFixtureUrl with an HTTPS fixture trusted by the test device. */
@RunWith(AndroidJUnit4::class)
class BrowserGuestHostTest {
    @Test fun queriesAndUnknownActionsDoNotConsumeWorkspaceCapacity() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val host = BrowserGuestHost(activity, activity.bridge.webView) {}
                fun input(id: String) = JSObject().put("threadId", id)
                try {
                    repeat(40) { index ->
                        val state = host.execute("getState", input("query-$index"))
                        assertFalse(state.getBoolean("open"))
                        assertEquals(0, state.getJSONArray("tabs").length())
                        assertThrows(IllegalArgumentException::class.java) {
                            host.execute("unknown", input("invalid-$index"))
                        }
                    }
                    repeat(17) { index ->
                        assertTrue(host.execute("open", input("browser-$index")).getBoolean("open"))
                        host.execute("hide", input("browser-$index"))
                    }
                    assertFalse(host.execute("getState", input("browser-0")).getBoolean("open"))
                    assertTrue(host.execute("getState", input("browser-1")).getBoolean("open"))
                    assertTrue(host.execute("getState", input("browser-16")).getBoolean("open"))
                } finally {
                    host.destroy()
                }
            }
        }
    }

    @Test fun isolatedHttpsGuestNavigatesCapturesAndRestoresTabs() {
        val url = InstrumentationRegistry.getArguments().getString("browserFixtureUrl")
        assumeTrue("HTTPS fixture argument required", !url.isNullOrBlank())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var host: BrowserGuestHost
            lateinit var shell: WebView
            var initialTab = ""
            fun command(operation: String, extras: JSObject = JSObject()): JSObject {
                var result = JSObject()
                scenario.onActivity {
                    extras.put("threadId", "native-browser-test")
                    result = host.execute(operation, extras)
                }
                return result
            }
            fun guest(): WebView {
                val parent = shell.parent as ViewGroup
                return (0 until parent.childCount).map { parent.getChildAt(it) }
                    .filterIsInstance<WebView>().first { it !== shell }
            }
            fun evaluate(script: String): String {
                var result = ""
                val latch = CountDownLatch(1)
                scenario.onActivity { guest().evaluateJavascript(script) { result = it; latch.countDown() } }
                assertTrue("Guest did not respond", latch.await(5, TimeUnit.SECONDS))
                return result
            }
            fun awaitPage() {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (System.nanoTime() < deadline) {
                    if (evaluate("document.title") == "\"Synara browser fixture\"") return
                    Thread.sleep(100)
                }
                fail("HTTPS guest fixture did not load")
            }
            scenario.onActivity { activity ->
                shell = activity.bridge.webView
                host = BrowserGuestHost(activity, shell) {}
            }
            // The Activity's initial layout is asynchronous.
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (shell.width == 0 && System.nanoTime() < deadline) Thread.sleep(100)
            try {
                initialTab = command("open", JSObject().put("initialUrl", url)).getString("activeTabId")!!
                val rect = JSObject().put("x", 0).put("y", 100).put("width", 390).put("height", 500)
                command("setPanelBounds", JSObject().put("viewportWidth", 390).put("bounds", rect))
                awaitPage()
                assertEquals("true", evaluate("typeof Capacitor === 'undefined' && typeof SynaraShell === 'undefined' && typeof Android === 'undefined'"))
                assertEquals("\"Clicked\"", evaluate("document.querySelector('#count').click(); document.querySelector('#count').textContent"))
                val shot = command("captureScreenshot", JSObject().put("tabId", initialTab))
                val bytes = Base64.decode(shot.getString("base64")!!, Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                assertNotNull("Capture must decode as PNG", bitmap)
                assertTrue(bitmap.width > 100 && bitmap.height > 100)
                assertTrue(maxOf(bitmap.width, bitmap.height) <= 1600)
                val colors = mutableSetOf<Int>()
                for (y in 0 until bitmap.height step 4) {
                    for (x in 0 until bitmap.width step 4) colors.add(bitmap.getPixel(x, y))
                }
                bitmap.recycle()
                assertTrue("Capture must contain rendered page content, not a blank image", colors.size > 10)
                assertTrue("Capture must contain opaque page pixels", colors.any { Color.alpha(it) == 255 })
                command("setPanelBounds", JSObject().put("viewportWidth", 390).put("bounds", org.json.JSONObject.NULL))
                scenario.onActivity { assertEquals(View.INVISIBLE, guest().visibility) }
                command("setPanelBounds", JSObject().put("viewportWidth", 390).put("bounds", rect))
                scenario.onActivity { assertEquals(View.VISIBLE, guest().visibility) }
                val second = command("newTab", JSObject().put("url", "$url?next=1")).getString("activeTabId")
                assertNotEquals(initialTab, second)
                awaitPage()
                command("selectTab", JSObject().put("tabId", initialTab))
                awaitPage()
                assertEquals(initialTab, command("getState").getString("activeTabId"))
                command("navigate", JSObject().put("tabId", initialTab).put("url", "$url?next=1"))
                awaitPage()
                val historyDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (!command("getState").getJSONArray("tabs").getJSONObject(0).getBoolean("canGoBack") && System.nanoTime() < historyDeadline) Thread.sleep(100)
                assertTrue(command("getState").getJSONArray("tabs").getJSONObject(0).getBoolean("canGoBack"))
                command("goBack", JSObject().put("tabId", initialTab))
                scenario.onActivity {
                    assertNotSame(shell, guest())
                    assertTrue(shell.url?.startsWith("https://app.synara.local") == true)
                    host.pause(); assertEquals(View.INVISIBLE, guest().visibility)
                    host.resume(); assertEquals(View.VISIBLE, guest().visibility)
                }
            } finally { scenario.onActivity { host.destroy() } }
        }
    }
}
