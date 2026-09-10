package com.synara.android

import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NativePresentationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test fun notificationPermissionMatchesAndroidAndGrantedNotificationIsPresented() {
        val manager = context.getSystemService(NotificationManager::class.java)
        val notificationId = 194082731
        val channelId = "synara-device-test"
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val before = invoke(scenario, "LocalNotifications", "checkPermissions")
            assertEquals(manager.areNotificationsEnabled(), before.getString("display") == "granted")
            if (Build.VERSION.SDK_INT >= 33) {
                instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
            }
            try {
                assertEquals("granted", invoke(scenario, "LocalNotifications", "checkPermissions").getString("display"))
                invoke(scenario, "LocalNotifications", "createChannel", JSONObject()
                    .put("id", channelId).put("name", "Device test").put("importance", 3))
                invoke(scenario, "LocalNotifications", "schedule", JSONObject("""
                    {"notifications":[{"id":$notificationId,"title":"Synara device test",
                    "body":"Disposable notification","channelId":"$channelId","isExactNotification":false}]}
                """.trimIndent()))
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (System.nanoTime() < deadline && manager.activeNotifications.none { it.id == notificationId }) {
                    Thread.sleep(100)
                }
                val delivered = manager.activeNotifications.single { it.id == notificationId }.notification
                assertEquals("Synara device test", delivered.extras.getString("android.title"))
                assertEquals("Disposable notification", delivered.extras.getString("android.text"))
                assertEquals(channelId, delivered.channelId)
            } finally {
                manager.cancel(notificationId)
                manager.deleteNotificationChannel(channelId)
            }
        }
    }

    @Test fun exportedBinaryIsSharedAsReadableContentUriWithoutOpeningADestination() {
        val bytes = ByteArray(600_013) { ((it * 37) % 256).toByte() }
        val relativePath = "synara-exports/device-instrumentation/export.bin"
        val chooserSeen = CountDownLatch(1)
        var outgoing: Intent? = null
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_CHOOSER) return null
                outgoing = intent
                chooserSeen.countDown()
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                invoke(scenario, "Filesystem", "writeFile", JSONObject()
                    .put("path", relativePath).put("directory", "CACHE").put("recursive", true).put("data", ""))
                for (offset in bytes.indices step (512 * 1024)) {
                    val chunk = bytes.copyOfRange(offset, minOf(offset + 512 * 1024, bytes.size))
                    invoke(scenario, "Filesystem", "appendFile", JSONObject()
                        .put("path", relativePath).put("directory", "CACHE")
                        .put("data", Base64.encodeToString(chunk, Base64.NO_WRAP)))
                }
                val fileUri = invoke(scenario, "Filesystem", "getUri", JSONObject()
                    .put("path", relativePath).put("directory", "CACHE")).getString("uri")
                invoke(scenario, "Share", "share", JSONObject()
                    .put("files", org.json.JSONArray().put(fileUri)).put("title", "export.bin"),
                    expectedError = "Share canceled")
                assertTrue("Share plugin did not open the chooser", chooserSeen.await(5, TimeUnit.SECONDS))
                @Suppress("DEPRECATION")
                val send = outgoing!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
                @Suppress("DEPRECATION")
                val contentUri = send.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
                assertEquals(Intent.ACTION_SEND, send.action)
                assertEquals("content", contentUri.scheme)
                assertEquals("${context.packageName}.fileprovider", contentUri.authority)
                assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
                val actual = context.contentResolver.openInputStream(contentUri)!!.use { it.readBytes() }
                assertArrayEquals(bytes, actual)
                assertThrows(IllegalArgumentException::class.java) {
                    FileProvider.getUriForFile(context, "${context.packageName}.fileprovider",
                        context.cacheDir.resolve("private-file-outside-exports.bin"))
                }
            }
        } finally {
            instrumentation.removeMonitor(monitor)
            context.cacheDir.resolve("synara-exports/device-instrumentation").deleteRecursively()
        }
    }

    private fun invoke(
        scenario: ActivityScenario<MainActivity>,
        plugin: String,
        method: String,
        options: JSONObject = JSONObject(),
        expectedError: String? = null,
    ): JSONObject {
        val script = """
            (function () {
              if (!document.body || !document.body.innerText || !window.Capacitor || !Capacitor.nativePromise) return null;
              if (window.nativeDeviceTest === undefined) {
                window.nativeDeviceTest = null;
                Capacitor.nativePromise('$plugin', '$method', $options).then(
                  function (value) { window.nativeDeviceTest = {value: value || {}}; },
                  function (error) { window.nativeDeviceTest = {error: String(error)}; }
                );
              }
              return window.nativeDeviceTest;
            })()
        """.trimIndent()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            val latch = CountDownLatch(1)
            var response: String? = null
            scenario.onActivity { activity ->
                activity.bridge.webView.evaluateJavascript(script) {
                    response = it
                    latch.countDown()
                }
            }
            assertTrue("WebView stopped responding", latch.await(5, TimeUnit.SECONDS))
            if (response != null && response != "null") {
                val result = JSONObject(response!!)
                scenario.onActivity { it.bridge.webView.evaluateJavascript("delete window.nativeDeviceTest", null) }
                if (expectedError != null) {
                    assertTrue("Expected $expectedError from $plugin.$method: $result",
                        result.optString("error").contains(expectedError))
                    return JSONObject()
                }
                assertFalse("$plugin.$method failed: $result", result.has("error"))
                return result.getJSONObject("value")
            }
            Thread.sleep(100)
        }
        throw AssertionError("$plugin.$method did not complete")
    }
}
