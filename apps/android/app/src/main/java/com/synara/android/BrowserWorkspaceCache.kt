package com.synara.android

/** Bounds retained tab histories while keeping the displayed workspace alive. */
internal class BrowserWorkspaceCache<T>(
    private val maxWorkspaces: Int,
    private val maxTabs: Int,
    private val tabCount: (T) -> Int,
    private val onEvicted: (T) -> Unit,
) {
    private val entries = linkedMapOf<String, T>()
    operator fun get(id: String): T? = entries[id]
    fun remove(id: String): T? = entries.remove(id)
    fun clear() = entries.clear()

    fun touch(id: String) {
        val value = entries.remove(id) ?: return
        entries[id] = value
    }

    fun getOrCreate(id: String, protectedIds: Set<String>, create: () -> T): T {
        entries[id]?.let { return it }
        while (entries.size >= maxWorkspaces) evictOldest(protectedIds)
        return create().also { entries[id] = it }
    }

    fun reserveTab(protectedIds: Set<String>) {
        while (entries.values.sumOf(tabCount) >= maxTabs) evictOldest(protectedIds)
    }

    private fun evictOldest(protectedIds: Set<String>) {
        val id = entries.keys.firstOrNull { it !in protectedIds }
            ?: throw IllegalArgumentException("Close an unused browser tab first.")
        val value = entries.remove(id) ?: return
        onEvicted(value)
    }
}
