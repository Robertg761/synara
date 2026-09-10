package com.synara.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WebViewCompatibilityTest {
    @Test fun unsupportedWebViewGetsBundledRecoveryPageInsteadOfRenderer() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var supported = false
            scenario.onActivity { supported = it.bridge.isMinimumWebViewInstalled }
            val expression = if (supported) {
                "location.pathname !== '/webview-error.html' && window.Capacitor.isNativePlatform()"
            } else {
                "location.pathname === '/webview-error.html' && " +
                    "document.body.innerText.indexOf('Update Android System WebView') >= 0 && " +
                    "document.querySelectorAll('script[src]').length === 0"
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            var ready = false
            while (System.nanoTime() < deadline) {
                val latch = CountDownLatch(1)
                scenario.onActivity { activity ->
                    activity.bridge.webView.evaluateJavascript(expression) {
                        ready = it == "true"
                        latch.countDown()
                    }
                }
                assertTrue("WebView stopped responding", latch.await(5, TimeUnit.SECONDS))
                if (ready) break
                Thread.sleep(100)
            }
            assertTrue("Startup did not match installed WebView support: $supported", ready)
        }
    }
}
