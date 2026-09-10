package com.synara.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class StoredSession(
    val baseUrl: String,
    val sessionToken: String,
)

class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    /** Encrypt first, then commit the URL and token together. A failed write rejects pairing. */
    @Synchronized
    fun saveSession(baseUrl: String, token: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val ciphertext = cipher.doFinal(token.toByteArray(StandardCharsets.UTF_8))
        check(preferences.edit()
            .putString(KEY_BASE_URL, baseUrl)
            .putString(KEY_SESSION_TOKEN, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .putString(KEY_SESSION_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .commit()) { "Secure session persistence failed." }
    }

    fun readBaseUrl(): String? = preferences.getString(KEY_BASE_URL, null)

    fun readSessionToken(): String? {
        val encodedCiphertext = preferences.getString(KEY_SESSION_TOKEN, null) ?: return null
        val encodedIv = preferences.getString(KEY_SESSION_IV, null) ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            encryptionKey(),
            GCMParameterSpec(TAG_LENGTH_BITS, Base64.decode(encodedIv, Base64.NO_WRAP)),
        )
        return String(
            cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP)),
            StandardCharsets.UTF_8,
        ).takeIf { it.isNotBlank() }
    }

    @Synchronized
    fun readSession(): StoredSession? {
        val baseUrl = readBaseUrl()?.takeIf { it.isNotBlank() } ?: return null
        val token = readSessionToken() ?: return null
        return StoredSession(baseUrl, token)
    }

    @Synchronized
    fun clearAll() {
        check(preferences.edit()
            .remove(KEY_BASE_URL)
            .remove(KEY_SESSION_TOKEN)
            .remove(KEY_SESSION_IV)
            .commit()) { "Secure session removal failed." }
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return keyGenerator.generateKey()
    }

    private companion object {
        const val PREFERENCES = "synara_session"
        const val KEY_BASE_URL = "base_url"
        const val KEY_SESSION_TOKEN = "session_token"
        const val KEY_SESSION_IV = "session_iv"
        const val KEY_ALIAS = "synara_session_key"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_LENGTH_BITS = 128
    }
}
