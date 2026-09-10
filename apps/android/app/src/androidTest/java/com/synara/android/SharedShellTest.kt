package com.synara.android

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.synara.android.data.SecureSessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises the packaged shared UI and real native bridge, without a server. */
@RunWith(AndroidJUnit4::class)
class SharedShellTest {
    @Test fun packagedAppLoadsTheSharedConnectScreenAndNativePlugins() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        SecureSessionStore(context).clearAll()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
            var ready = false
            while (System.nanoTime() < deadline) {
                val latch = CountDownLatch(1)
                scenario.onActivity { activity ->
                    val webView = activity.findViewById<WebView>(com.getcapacitor.android.R.id.webview)
                    webView.evaluateJavascript("""
                        Boolean(
                          location.origin === 'https://app.synara.local' &&
                          window.Capacitor?.isNativePlatform?.() &&
                          document.body.innerText.includes('Connect to your Synara server.')
                        )
                    """.trimIndent()) {
                        ready = it == "true"
                        latch.countDown()
                    }
                }
                assertTrue("WebView stopped responding", latch.await(5, TimeUnit.SECONDS))
                if (ready) break
                Thread.sleep(200)
            }
            assertTrue("The packaged shared connect screen did not load", ready)
            val latch = CountDownLatch(1)
            scenario.onActivity { activity ->
                val webView = activity.findViewById<WebView>(com.getcapacitor.android.R.id.webview)
                webView.evaluateJavascript(
                    "Capacitor.isPluginAvailable('SynaraShell') && Capacitor.isPluginAvailable('App')"
                ) {
                    assertEquals("true", it)
                    latch.countDown()
                }
            }
            assertTrue(latch.await(5, TimeUnit.SECONDS))
        }
    }
}
