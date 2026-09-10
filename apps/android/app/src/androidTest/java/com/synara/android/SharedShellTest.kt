package com.synara.android

import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.platform.app.InstrumentationRegistry
import com.synara.android.data.SecureSessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises the packaged shared UI and real native bridge, without a server. */
@RunWith(AndroidJUnit4::class)
class SharedShellTest {
    @Test fun consumedPairingLaunchIsNotReplayedAfterRendererOrActivityRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        SecureSessionStore(context).clearAll()
        // A reserved invalid host avoids depending on a live server or real credentials.
        val launch = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse("synara://pair?server=https%3A%2F%2Fpairing.invalid&token=device-test")
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        var activity = instrumentation.startActivitySync(launch) as MainActivity
        try {
            awaitJavascript(activity, "window.Capacitor?.isNativePlatform?.() === true")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            var consumed = false
            while (System.nanoTime() < deadline) {
                instrumentation.runOnMainSync { consumed = activity.intent.data == null }
                if (consumed) break
                Thread.sleep(100)
            }
            assertTrue("Shared renderer did not consume the pairing launch intent", consumed)
            awaitJavascript(activity, "window.beforeTestReload = true")
            instrumentation.runOnMainSync { activity.bridge.webView.reload() }
            awaitJavascript(activity, "window.beforeTestReload === undefined && window.Capacitor?.isNativePlatform?.() === true")
            assertNoLaunchUrl(activity)

            // ActivityScenario identifies recreated activities by their original intent.
            // Consuming the URL intentionally changes that intent, so observe lifecycle directly.
            val previousActivity = activity
            instrumentation.runOnMainSync { previousActivity.recreate() }
            val recreationDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < recreationDeadline && activity === previousActivity) {
                instrumentation.runOnMainSync {
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<MainActivity>()
                        .firstOrNull { it !== previousActivity }
                        ?.let { activity = it }
                }
                Thread.sleep(100)
            }
            assertTrue("Activity did not recreate", activity !== previousActivity)
            assertNoLaunchUrl(activity)
            instrumentation.runOnMainSync { assertNull(activity.intent.data) }
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun staleExpectedUrlDoesNotConsumeANewerIntent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        SecureSessionStore(context).clearAll()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitJavascript(scenario, "document.body.innerText.includes('Connect to your Synara server.')")
            val currentUrl = "synara://pair?server=https%3A%2F%2Fpairing.invalid&token=newer"
            scenario.onActivity { it.intent.data = Uri.parse(currentUrl) }
            awaitJavascript(scenario, """
                (() => {
                  if (!window.launchCheckStarted) {
                    window.launchCheckStarted = true;
                    Capacitor.nativePromise('SynaraShell', 'consumeLaunchUrl', {expectedUrl: 'stale'})
                      .then(result => window.launchCheck = result.url === undefined);
                  }
                  return window.launchCheck === true;
                })()
            """.trimIndent())
            scenario.onActivity { assertEquals(currentUrl, it.intent.dataString) }
            awaitJavascript(scenario, """
                (() => {
                  if (!window.consumeCheckStarted) {
                    window.consumeCheckStarted = true;
                    Capacitor.nativePromise('SynaraShell', 'consumeLaunchUrl', {expectedUrl: '$currentUrl'})
                      .then(result => window.consumeCheck = result.url === '$currentUrl');
                  }
                  return window.consumeCheck === true;
                })()
            """.trimIndent())
            scenario.onActivity { assertNull(it.intent.data) }
        }
    }

    @Test fun sharedBackgroundSurvivesSystemBarConfigurationReset() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitJavascript(scenario, "document.documentElement.hasAttribute('data-theme-variant')")
            for (color in listOf("#f4f4fa", "#171723")) {
                awaitJavascript(scenario, """
                    (() => {
                      if (window.backgroundRequest !== '$color') {
                        window.backgroundRequest = '$color'; window.backgroundReady = false;
                        Capacitor.nativePromise('SystemBars', 'setStyle', {style: '${if (color == "#f4f4fa") "LIGHT" else "DARK"}'})
                          .then(() => Capacitor.nativePromise('SynaraShell', 'setBackgroundColor', {color: '$color'}))
                          .then(() => window.backgroundReady = true);
                      }
                      return window.backgroundReady === true;
                    })()
                """.trimIndent())
                scenario.onActivity {
                    val expected = android.graphics.Color.parseColor(color)
                    assertEquals(expected, (it.window.decorView.background as android.graphics.drawable.ColorDrawable).color)
                    it.bridge.onConfigurationChanged(android.content.res.Configuration(it.resources.configuration))
                }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity {
                    val expected = android.graphics.Color.parseColor(color)
                    assertEquals(expected, (it.window.decorView.background as android.graphics.drawable.ColorDrawable).color)
                    assertEquals(expected, ((it.bridge.webView.parent as android.view.View).background as android.graphics.drawable.ColorDrawable).color)
                }
            }
        }
    }

    private fun assertNoLaunchUrl(activity: MainActivity) {
        awaitJavascript(activity, "document.body.innerText.includes('Connect to your Synara server.')")
        awaitJavascript(activity, """
            (() => {
              if (!window.Capacitor?.isNativePlatform?.()) return false;
              if (!window.replayCheckStarted) {
                window.replayCheckStarted = true;
                Capacitor.nativePromise('SynaraShell', 'consumeLaunchUrl', {})
                  .then(result => window.replayCheck = result.url === undefined);
              }
              return window.replayCheck === true;
            })()
        """.trimIndent())
    }

    private fun awaitJavascript(activity: MainActivity, expression: String) {
        awaitJavascriptOnMain(expression) { callback ->
            InstrumentationRegistry.getInstrumentation().runOnMainSync { callback(activity) }
        }
    }

    private fun awaitJavascript(scenario: ActivityScenario<MainActivity>, expression: String) {
        awaitJavascriptOnMain(expression) { callback -> scenario.onActivity { callback(it) } }
    }

    private fun awaitJavascriptOnMain(expression: String, onActivity: ((MainActivity) -> Unit) -> Unit) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (System.nanoTime() < deadline) {
            val latch = CountDownLatch(1)
            var result: String? = null
            onActivity { activity ->
                activity.bridge.webView.evaluateJavascript(expression) {
                    result = it
                    latch.countDown()
                }
            }
            assertTrue("WebView stopped responding", latch.await(5, TimeUnit.SECONDS))
            if (result == "true") return
            Thread.sleep(100)
        }
        throw AssertionError("WebView condition did not become true: $expression")
    }

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
