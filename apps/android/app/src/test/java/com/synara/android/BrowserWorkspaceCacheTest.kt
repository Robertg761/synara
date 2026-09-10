package com.synara.android

import org.junit.Assert.*
import org.junit.Test

class BrowserWorkspaceCacheTest {
    private data class Workspace(var tabs: Int = 1)

    @Test fun seventeenthWorkspaceEvictsLeastRecentlyUsedHiddenHistory() {
        val evicted = mutableListOf<Workspace>()
        val cache = BrowserWorkspaceCache<Workspace>(16, 32, { it.tabs }, evicted::add)
        val original = (0 until 16).map { index -> cache.getOrCreate("$index", emptySet()) { Workspace() } }
        cache.touch("1")
        cache.getOrCreate("16", setOf("0")) { Workspace() }
        assertSame(original[0], cache["0"])
        assertSame(original[1], cache["1"])
        assertNull(cache["2"])
        assertEquals(listOf(original[2]), evicted)
        assertNotNull(cache["16"])
    }

    @Test fun queriesDoNotAllocateOrChangeEvictionOrder() {
        val cache = BrowserWorkspaceCache<Workspace>(2, 32, { it.tabs }, {})
        val oldest = cache.getOrCreate("oldest", emptySet()) { Workspace() }
        cache.getOrCreate("newer", emptySet()) { Workspace() }
        repeat(100) { assertNull(cache["missing-$it"]) }
        assertSame(oldest, cache["oldest"])
        cache.getOrCreate("third", emptySet()) { Workspace() }
        assertNull(cache["oldest"])
        assertNotNull(cache["newer"])
    }

    @Test fun globalTabLimitReclaimsHiddenWorkspaceButPreservesDisplayedTabs() {
        val cache = BrowserWorkspaceCache<Workspace>(16, 32, { it.tabs }, {})
        val active = cache.getOrCreate("active", emptySet()) { Workspace(20) }
        cache.getOrCreate("hidden", emptySet()) { Workspace(12) }
        cache.reserveTab(setOf("active"))
        active.tabs += 1
        assertSame(active, cache["active"])
        assertNull(cache["hidden"])
        active.tabs = 32
        assertThrows(IllegalArgumentException::class.java) { cache.reserveTab(setOf("active")) }
        assertEquals(32, active.tabs)
    }
}
