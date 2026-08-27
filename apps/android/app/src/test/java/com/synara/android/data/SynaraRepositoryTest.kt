package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SynaraRepositoryTest {
    @Test
    fun normalizesServerUrlsWithoutInventingAPath() {
        assertEquals("http://192.168.1.20:3773/", SynaraRepository.normalizeBaseUrl("192.168.1.20:3773").toString())
        assertEquals("https://synara.example.test/", SynaraRepository.normalizeBaseUrl("https://synara.example.test/").toString())
    }

    @Test
    fun rejectsMalformedServerUrls() {
        assertThrows(IllegalArgumentException::class.java) {
            SynaraRepository.normalizeBaseUrl("not a server")
        }
    }

    @Test
    fun extractsPairingCredentialFromRawValuesAndLinks() {
        assertEquals("raw-token", SynaraRepository.extractPairingCredential("raw-token"))
        assertEquals(
            "fragment-token",
            SynaraRepository.extractPairingCredential("https://synara.example.test/pair#token=fragment-token"),
        )
        assertEquals(
            "query-token",
            SynaraRepository.extractPairingCredential("https://synara.example.test/pair?token=query-token"),
        )
        assertEquals("", SynaraRepository.extractPairingCredential("  "))
    }
}
