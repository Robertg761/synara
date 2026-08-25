package com.synara.android.data

/**
 * A minimal unified-diff parser.
 *
 * Every diff RPC in the protocol returns one flat patch string — `orchestration.getTurnDiff`,
 * `getFullThreadDiff` and `git.readWorkingTreeDiff` all hand back `diff`/`patch` text rather than a
 * structured payload — so a client that wants a file list, per-file counts, or syntax-coloured
 * lines has to parse it. Rendering the raw string instead, which is the only thing the app could do
 * before, turns a 4,000-line patch into an unnavigable wall of monospace.
 *
 * The parser is deliberately tolerant: agent-produced patches routinely include binary markers,
 * renames, mode-only changes, and truncated tails from an interrupted turn. Anything it does not
 * recognise is preserved as context rather than dropped, so no change is ever silently hidden.
 */
enum class DiffLineKind { CONTEXT, ADDED, REMOVED, META }

data class DiffLine(
    val kind: DiffLineKind,
    val text: String,
    /** 1-based line number in the pre-image, null for added lines. */
    val oldNumber: Int?,
    /** 1-based line number in the post-image, null for removed lines. */
    val newNumber: Int?,
)

data class DiffHunk(
    val header: String,
    val lines: List<DiffLine>,
)

enum class DiffFileStatus { ADDED, DELETED, RENAMED, MODIFIED }

data class DiffFile(
    val path: String,
    val oldPath: String?,
    val status: DiffFileStatus,
    val hunks: List<DiffHunk>,
    val insertions: Int,
    val deletions: Int,
    val isBinary: Boolean,
) {
    /** Display name; renames read as "old → new". */
    val displayPath: String
        get() = if (status == DiffFileStatus.RENAMED && oldPath != null) "$oldPath → $path" else path

    val fileName: String
        get() = path.substringAfterLast('/')

    val directory: String
        get() = path.substringBeforeLast('/', "")
}

data class ParsedDiff(
    val files: List<DiffFile>,
) {
    val insertions: Int get() = files.sumOf { it.insertions }
    val deletions: Int get() = files.sumOf { it.deletions }
    val isEmpty: Boolean get() = files.isEmpty()
}

private val HUNK_HEADER = Regex("""^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$""")

fun parseUnifiedDiff(patch: String): ParsedDiff {
    if (patch.isBlank()) return ParsedDiff(emptyList())

    val files = mutableListOf<DiffFile>()

    // Per-file accumulators, reset by flush().
    var path: String? = null
    var oldPath: String? = null
    var status = DiffFileStatus.MODIFIED
    var isBinary = false
    var hunks = mutableListOf<DiffHunk>()
    var hunkHeader: String? = null
    var hunkLines = mutableListOf<DiffLine>()
    var oldLine = 0
    var newLine = 0

    fun flushHunk() {
        val header = hunkHeader ?: return
        hunks += DiffHunk(header, hunkLines.toList())
        hunkHeader = null
        hunkLines = mutableListOf()
    }

    fun flushFile() {
        flushHunk()
        val current = path ?: return
        val added = hunks.sumOf { hunk -> hunk.lines.count { it.kind == DiffLineKind.ADDED } }
        val removed = hunks.sumOf { hunk -> hunk.lines.count { it.kind == DiffLineKind.REMOVED } }
        files += DiffFile(
            path = current,
            oldPath = oldPath?.takeIf { it != current },
            status = status,
            hunks = hunks.toList(),
            insertions = added,
            deletions = removed,
            isBinary = isBinary,
        )
        path = null
        oldPath = null
        status = DiffFileStatus.MODIFIED
        isBinary = false
        hunks = mutableListOf()
    }

    for (raw in patch.lines()) {
        when {
            raw.startsWith("diff --git ") -> {
                flushFile()
                // `diff --git a/x b/y` — the a/ and b/ paths, which may contain spaces. Taking the
                // trailing b/ path is more reliable than splitting on whitespace.
                val rest = raw.removePrefix("diff --git ")
                val bIndex = rest.lastIndexOf(" b/")
                if (bIndex >= 0) {
                    oldPath = rest.substring(0, bIndex).removePrefix("a/")
                    path = rest.substring(bIndex + 3)
                } else {
                    path = rest
                }
            }

            raw.startsWith("new file mode") -> status = DiffFileStatus.ADDED
            raw.startsWith("deleted file mode") -> status = DiffFileStatus.DELETED
            raw.startsWith("rename from ") -> {
                status = DiffFileStatus.RENAMED
                oldPath = raw.removePrefix("rename from ")
            }

            raw.startsWith("rename to ") -> {
                status = DiffFileStatus.RENAMED
                path = raw.removePrefix("rename to ")
            }

            raw.startsWith("Binary files") || raw.startsWith("GIT binary patch") -> isBinary = true

            raw.startsWith("--- ") -> {
                val value = raw.removePrefix("--- ")
                if (value != "/dev/null") oldPath = value.removePrefix("a/")
                // A bare `--- / +++` pair with no `diff --git` header happens with `git diff
                // --no-prefix` and with some provider-generated patches.
                if (path == null && value != "/dev/null") path = value.removePrefix("a/")
            }

            raw.startsWith("+++ ") -> {
                val value = raw.removePrefix("+++ ")
                if (value != "/dev/null") path = value.removePrefix("b/")
                else if (path == null) path = oldPath
            }

            raw.startsWith("@@") -> {
                val match = HUNK_HEADER.find(raw)
                if (match != null) {
                    flushHunk()
                    oldLine = match.groupValues[1].toIntOrNull() ?: 1
                    newLine = match.groupValues[3].toIntOrNull() ?: 1
                    hunkHeader = match.groupValues[5].trim().ifBlank { raw }
                }
            }

            hunkHeader != null -> when {
                raw.startsWith("+") -> {
                    hunkLines += DiffLine(DiffLineKind.ADDED, raw.drop(1), null, newLine)
                    newLine++
                }

                raw.startsWith("-") -> {
                    hunkLines += DiffLine(DiffLineKind.REMOVED, raw.drop(1), oldLine, null)
                    oldLine++
                }

                // "\ No newline at end of file" belongs to the previous line, not the line grid.
                raw.startsWith("\\") ->
                    hunkLines += DiffLine(DiffLineKind.META, raw, null, null)

                else -> {
                    hunkLines += DiffLine(DiffLineKind.CONTEXT, raw.removePrefix(" "), oldLine, newLine)
                    oldLine++
                    newLine++
                }
            }
        }
    }
    flushFile()

    return ParsedDiff(files)
}
