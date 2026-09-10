package com.synara.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.synara.android.data.SecureSessionStore
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

@RunWith(AndroidJUnit4::class)
class SecureSessionStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val store = SecureSessionStore(context)

    @Before fun clearBefore() { store.clearAll() }
    @After fun clearAfter() { store.clearAll() }

    @Test fun persistsAcrossInstancesWithoutPlaintextCredentials() {
        store.saveSession("https://box.example", "test-secret")
        val restored = SecureSessionStore(context).readSession()!!
        assertEquals("https://box.example", restored.baseUrl)
        assertEquals("test-secret", restored.sessionToken)
        val preferences = context.getSharedPreferences("synara_session", Context.MODE_PRIVATE)
        assertFalse(preferences.all.values.any { it.toString().contains("test-secret") })
        store.clearAll()
        assertNull(SecureSessionStore(context).readSession())
    }

    @Test fun readsThePreviousComposeAppsEncryptedSession() {
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = (keys.getKey("synara_session_key", null) as? SecretKey)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(
                    "synara_session_key",
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
                generateKey()
            }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val ciphertext = cipher.doFinal("legacy-secret".toByteArray(Charsets.UTF_8))
        context.getSharedPreferences("synara_session", Context.MODE_PRIVATE).edit()
            .putString("base_url", "https://legacy.example")
            .putString("session_token", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .putString("session_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .commit()
        assertEquals("legacy-secret", store.readSession()!!.sessionToken)
        assertEquals("https://legacy.example", store.readSession()!!.baseUrl)
    }

    @Test fun doesNotEraseCredentialsWhenDecryptionFails() {
        store.saveSession("https://box.example", "secret")
        val preferences = context.getSharedPreferences("synara_session", Context.MODE_PRIVATE)
        preferences.edit().putString("session_iv", "bad").commit()
        assertThrows(Exception::class.java) { store.readSession() }
        assertTrue(preferences.contains("session_token"))
    }
}
