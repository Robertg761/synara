package com.synara.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionPolicyTest {
    @Test fun acceptsHttpsOrigins() {
        assertTrue(SessionPolicy.isValid("https://box.example:8443", "token"))
        assertTrue(SessionPolicy.isValid("https://[::1]/", "token"))
    }

    @Test fun rejectsInsecureOrAmbiguousEndpoints() {
        listOf(
            "http://box.example", "javascript:alert(1)", "https://user:password@box.example",
            "https://box.example/path", "https://box.example?token=secret",
            "https://box.example#fragment", "https://box.example:70000", "https://",
        ).forEach { assertFalse(it, SessionPolicy.isValid(it, "token")) }
        assertFalse(SessionPolicy.isValid("https://box.example", " "))
        assertFalse(SessionPolicy.isValid(null, "token"))
    }
}
