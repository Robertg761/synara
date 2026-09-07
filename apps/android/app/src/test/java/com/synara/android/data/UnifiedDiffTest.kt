package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UnifiedDiffTest {
    @Test
    fun `parses a modified file with counts and line numbers`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/src/app.ts b/src/app.ts
            index 1111111..2222222 100644
            --- a/src/app.ts
            +++ b/src/app.ts
            @@ -10,4 +10,5 @@ export function boot() {
               const a = 1;
            -  const b = 2;
            +  const b = 3;
            +  const c = 4;
               return a;
            """.trimIndent(),
        )

        assertEquals(1, parsed.files.size)
        val file = parsed.files.single()
        assertEquals("src/app.ts", file.path)
        assertEquals(DiffFileStatus.MODIFIED, file.status)
        assertEquals(2, file.insertions)
        assertEquals(1, file.deletions)

        val lines = file.hunks.single().lines
        // Context lines advance both sides; an addition only advances the new side.
        assertEquals(listOf(10, 11, null, null, 12), lines.map { it.oldNumber })
        assertEquals(listOf(10, null, 11, 12, 13), lines.map { it.newNumber })
        assertEquals("export function boot() {", file.hunks.single().header)
    }

    @Test
    fun `detects added and deleted files`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/new.txt b/new.txt
            new file mode 100644
            --- /dev/null
            +++ b/new.txt
            @@ -0,0 +1,1 @@
            +hello
            diff --git a/gone.txt b/gone.txt
            deleted file mode 100644
            --- a/gone.txt
            +++ /dev/null
            @@ -1,1 +0,0 @@
            -bye
            """.trimIndent(),
        )

        assertEquals(2, parsed.files.size)
        assertEquals(DiffFileStatus.ADDED, parsed.files[0].status)
        assertEquals("new.txt", parsed.files[0].path)
        assertEquals(DiffFileStatus.DELETED, parsed.files[1].status)
        assertEquals("gone.txt", parsed.files[1].path)
        assertEquals(1, parsed.insertions)
        assertEquals(1, parsed.deletions)
    }

    @Test
    fun `detects renames and reports both paths`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/old/name.kt b/new/name.kt
            similarity index 96%
            rename from old/name.kt
            rename to new/name.kt
            """.trimIndent(),
        )

        val file = parsed.files.single()
        assertEquals(DiffFileStatus.RENAMED, file.status)
        assertEquals("new/name.kt", file.path)
        assertEquals("old/name.kt", file.oldPath)
        assertEquals("old/name.kt → new/name.kt", file.displayPath)
    }

    @Test
    fun `flags binary files instead of trying to render them`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/logo.png b/logo.png
            index 3333333..4444444 100644
            Binary files a/logo.png and b/logo.png differ
            """.trimIndent(),
        )

        val file = parsed.files.single()
        assertTrue(file.isBinary)
        assertTrue(file.hunks.isEmpty())
    }

    @Test
    fun `keeps a hunk that a stopped turn truncated mid-file`() {
        // An interrupted turn can flush a patch that ends part-way through a hunk. The lines that
        // did arrive still describe real changes and must not be discarded.
        val parsed = parseUnifiedDiff(
            """
            diff --git a/partial.kt b/partial.kt
            --- a/partial.kt
            +++ b/partial.kt
            @@ -1,5 +1,6 @@
             fun main() {
            +    println("added")
            """.trimIndent(),
        )

        val file = parsed.files.single()
        assertEquals(1, file.insertions)
        assertEquals(0, file.deletions)
        assertEquals(2, file.hunks.single().lines.size)
    }

    @Test
    fun `handles paths containing spaces`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/my docs/read me.md b/my docs/read me.md
            --- a/my docs/read me.md
            +++ b/my docs/read me.md
            @@ -1,1 +1,1 @@
            -old
            +new
            """.trimIndent(),
        )

        assertEquals("my docs/read me.md", parsed.files.single().path)
        assertNull(parsed.files.single().oldPath)
    }

    @Test
    fun `treats a no-newline marker as metadata rather than a change`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/a.txt b/a.txt
            --- a/a.txt
            +++ b/a.txt
            @@ -1,1 +1,1 @@
            -one
            \ No newline at end of file
            +two
            """.trimIndent(),
        )

        val file = parsed.files.single()
        assertEquals(1, file.insertions)
        assertEquals(1, file.deletions)
        assertEquals(1, file.hunks.single().lines.count { it.kind == DiffLineKind.META })
    }

    @Test
    fun `returns nothing for an empty patch`() {
        assertTrue(parseUnifiedDiff("").isEmpty)
        assertTrue(parseUnifiedDiff("   \n \n").isEmpty)
    }

    @Test
    fun `splits multiple hunks in one file`() {
        val parsed = parseUnifiedDiff(
            """
            diff --git a/m.kt b/m.kt
            --- a/m.kt
            +++ b/m.kt
            @@ -1,3 +1,3 @@ first
             a
            -b
            +B
            @@ -20,3 +20,3 @@ second
             x
            -y
            +Y
            """.trimIndent(),
        )

        val file = parsed.files.single()
        assertEquals(2, file.hunks.size)
        assertEquals("first", file.hunks[0].header)
        assertEquals("second", file.hunks[1].header)
        assertEquals(20, file.hunks[1].lines.first().oldNumber)
    }
}
