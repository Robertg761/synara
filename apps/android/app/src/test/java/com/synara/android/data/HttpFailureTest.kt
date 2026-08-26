package com.synara.android.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpFailureTest {
    @Test
    fun namesTheRemedyRatherThanTheStatusCode() {
        assertTrue(httpFailureMessage(404).contains("older version"))
        assertTrue(httpFailureMessage(429).contains("busy"))
        assertTrue(httpFailureMessage(503).contains("still running"))
    }

    @Test
    fun keepsTheCodeOnlyWhereThereIsNothingBetterToSay() {
        // A reader can act on "your server crashed"; the number is there for a bug report, not
        // instead of the sentence.
        assertTrue(httpFailureMessage(500).startsWith("Your Synara server hit an error"))
        assertTrue(httpFailureMessage(500).contains("500"))
        assertTrue(httpFailureMessage(418).contains("418"))
    }

    @Test
    fun neverLeaksTheBareStatusPhrasing() {
        // The old copy read "Synara returned HTTP 404.", which described the wire and not the
        // problem. No branch may regress to it.
        for (code in listOf(400, 404, 408, 409, 429, 500, 502, 503, 504)) {
            assertFalse(code.toString(), httpFailureMessage(code).startsWith("Synara returned HTTP"))
        }
    }
}
