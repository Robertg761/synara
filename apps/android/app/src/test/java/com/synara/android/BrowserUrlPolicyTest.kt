package com.synara.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserUrlPolicyTest {
    @Test fun acceptsHttpsAndTheEmptyTab() {
        listOf("about:blank", "https://example.com/page?q=a#b", "https://box.example:8443", "https://[::1]:443/")
            .forEach { assertTrue(it, BrowserUrlPolicy.allows(it)) }
    }
    @Test fun rejectsShellOriginsAndUnsafeSchemes() {
        listOf("https://app.synara.local", "https://APP.SYNARA.LOCAL./path", "http://example.com",
            "javascript:alert(1)", "file:///tmp/private", "content://private", "data:text/html,hello",
            "https://user:password@example.com", "https://example.com:70000", "https://", "https://a\\b",
            "https://example.com/\nprivate").forEach { assertFalse(it, BrowserUrlPolicy.allows(it)) }
    }
}
