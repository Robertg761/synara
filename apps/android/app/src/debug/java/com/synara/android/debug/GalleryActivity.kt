package com.synara.android.debug

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.synara.android.data.ActivityItem
import com.synara.android.data.AppScreen
import com.synara.android.data.ConnectionState
import com.synara.android.data.Automation
import com.synara.android.data.AutomationList
import com.synara.android.data.AutomationMode
import com.synara.android.data.AutomationRun
import com.synara.android.data.AutomationSchedule
import com.synara.android.data.AutomationsState
import com.synara.android.data.CatalogueEntry
import com.synara.android.data.CatalogueState
import com.synara.android.data.DiffScope
import com.synara.android.data.ProviderCatalogue
import com.synara.android.data.GitBranchItem
import com.synara.android.data.GitBranches
import com.synara.android.data.GitFileChange
import com.synara.android.data.GitPullRequestInfo
import com.synara.android.data.CheckStatus
import com.synara.android.data.GitCheck
import com.synara.android.data.GitReviewComment
import com.synara.android.data.GitStatus
import com.synara.android.data.PullRequestSnapshot
import com.synara.android.data.PullRequestState
import com.synara.android.data.SourceControlState
import com.synara.android.data.SpaceItem
import com.synara.android.data.TerminalSnapshot
import com.synara.android.data.TerminalState
import com.synara.android.data.DiffState
import com.synara.android.data.parseUnifiedDiff
import com.synara.android.data.MessageItem
import com.synara.android.data.ModelOption
import com.synara.android.data.PendingInteraction
import com.synara.android.data.ProjectItem
import com.synara.android.data.SynaraRepository
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.ThreadDetail
import com.synara.android.data.ThreadItem
import com.synara.android.ui.screens.AutomationsScreen
import com.synara.android.ui.screens.CatalogueScreen
import com.synara.android.ui.screens.ChatScreen
import com.synara.android.ui.screens.KanbanScreen
import com.synara.android.ui.screens.PullRequestScreen
import com.synara.android.ui.screens.DiffScreen
import com.synara.android.ui.screens.SettingsScreen
import com.synara.android.ui.screens.SourceControlScreen
import com.synara.android.ui.screens.TerminalScreen
import com.synara.android.ui.screens.SetupScreen
import com.synara.android.ui.screens.WorkspaceScreen
import com.synara.android.ui.theme.SynaraTheme
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Debug-only harness for looking at the UI.
 *
 * Every screen in this app renders from a `SynaraUiState` value, so each visual state — empty,
 * loading, offline, streaming, approval-pending — can be rendered from a fixture without a paired
 * server. That matters because the states worth checking are exactly the ones a live server will
 * not reproduce on demand.
 *
 * Lives in `src/debug`, so it is absent from release builds. Drive it with:
 *
 *   adb shell am start -n com.synara.android/com.synara.android.debug.GalleryActivity \
 *       -e scene workspace --ez dark true
 */
class GalleryActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        val scene = intent.getStringExtra("scene") ?: "workspace"
        val forcedDark = if (intent.hasExtra("dark")) intent.getBooleanExtra("dark", true) else null

        setContent {
            SynaraTheme(darkTheme = forcedDark ?: isSystemInDarkTheme()) {
                // A real view model supplies the callbacks; the rendered state is the fixture
                // passed in below, never the view model's own.
                val vm: SynaraViewModel = viewModel(
                    factory = SynaraViewModel.factory(SynaraRepository(applicationContext)),
                )
                Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
                    when (scene) {
                        "setup" -> SetupScreen(Fixtures.setup(), { _, _ -> }, {})
                        "setup-error" -> SetupScreen(Fixtures.setupError(), { _, _ -> }, {})
                        "workspace" -> WorkspaceScreen(Fixtures.workspace(), vm)
                        "workspace-spaces" -> WorkspaceScreen(Fixtures.workspaceSpaces(), vm)
                        "workspace-empty" -> WorkspaceScreen(Fixtures.workspaceEmpty(), vm)
                        "workspace-no-projects" -> WorkspaceScreen(Fixtures.workspaceNoProjects(), vm)
                        "workspace-loading" -> WorkspaceScreen(Fixtures.workspaceLoading(), vm)
                        "workspace-offline" -> WorkspaceScreen(Fixtures.workspaceOffline(), vm)
                        "workspace-error" -> WorkspaceScreen(Fixtures.workspaceError(), vm)
                        "dialog-thread" -> WorkspaceScreen(Fixtures.createThreadOpen(), vm)
                        "thread-actions" -> WorkspaceScreen(Fixtures.threadActions(), vm)
                        "project-actions" -> WorkspaceScreen(Fixtures.projectActions(), vm)
                        "workspace-archived" -> WorkspaceScreen(Fixtures.workspaceArchived(), vm)
                        "dialog-project" -> WorkspaceScreen(Fixtures.createProjectOpen(), vm)
                        "chat" -> ChatScreen(Fixtures.chat(), vm)
                        "chat-plan" -> ChatScreen(Fixtures.chatPlanMode(), vm)
                        "chat-approval" -> ChatScreen(Fixtures.chatApproval(), vm)
                        "chat-question" -> ChatScreen(Fixtures.chatQuestion(), vm)
                        "chat-empty" -> ChatScreen(Fixtures.chatEmpty(), vm)
                        "diff" -> DiffScreen(Fixtures.diff(), vm)
                        "diff-empty" -> DiffScreen(Fixtures.diffEmpty(), vm)
                        "git" -> SourceControlScreen(Fixtures.sourceControl(), vm)
                        "git-branches" -> SourceControlScreen(Fixtures.sourceControlBranches(), vm)
                        "automations" -> AutomationsScreen(Fixtures.automations(), vm)
                        "automation-detail" -> AutomationsScreen(Fixtures.automationDetail(), vm)
                        "terminal" -> {
                            // The buffer lives on the view model, so the fixture feeds it directly.
                            remember { vm.terminalBuffer.append(Fixtures.TERMINAL_OUTPUT) }
                            TerminalScreen(Fixtures.terminal(), vm)
                        }
                        "kanban" -> KanbanScreen(Fixtures.kanban(), vm)
                        "catalogue" -> CatalogueScreen(Fixtures.catalogue(), vm)
                        "pr" -> PullRequestScreen(Fixtures.pullRequest(), vm)
                        "settings" -> SettingsScreen(Fixtures.settings(), vm)
                        else -> WorkspaceScreen(Fixtures.workspace(), vm)
                    }
                }
            }
        }
    }
}

private object Fixtures {
    private fun ago(amount: Long, unit: ChronoUnit): String =
        Instant.now().minus(amount, unit).toString()

    private val models = listOf(
        ModelOption("gpt-5.6-sol", "GPT-5.6 Sol", "Fast, high-reasoning default"),
        ModelOption("claude-opus-5", "Claude Opus 5", "Strongest taste for UI work", "claudeAgent"),
        ModelOption("claude-sonnet-5", "Claude Sonnet 5", null, "claudeAgent"),
        ModelOption("composer-1", "Composer", null, "cursor"),
        ModelOption("grok-code", "Grok Code", null, "grok"),
        ModelOption("droid-core", "Droid Core", null, "droid"),
    )

    private val projects = listOf(
        ProjectItem("p1", "synara", "/home/me/projects/synara", isPinned = true, spaceId = null, threadCount = 3),
        ProjectItem("p2", "orbit-api", "/home/me/projects/orbit-api", isPinned = false, spaceId = null, threadCount = 1),
    )

    private fun thread(
        id: String,
        title: String,
        provider: String = "codex",
        model: String = "gpt-5.6-sol",
        projectId: String = "p1",
        running: Boolean = false,
        approvals: Boolean = false,
        userInput: Boolean = false,
        updatedAgo: Long = 5,
        unit: ChronoUnit = ChronoUnit.MINUTES,
    ) = ThreadItem(
        id = id,
        projectId = projectId,
        title = title,
        provider = provider,
        model = model,
        runtimeMode = "approval-required",
        interactionMode = "default",
        latestTurn = com.synara.android.data.LatestTurn("t1", if (running) "running" else "completed"),
        sessionStatus = if (running) "running" else "idle",
        activeTurnId = if (running) "t1" else null,
        hasPendingApprovals = approvals,
        hasPendingUserInput = userInput,
        isPinned = false,
        archivedAt = null,
        updatedAt = ago(updatedAgo, unit),
        workingDirectory = "/home/me/projects/synara",
        worktreePath = null,
        branch = "main",
    )

    private val threads = listOf(
        thread("t-approve", "Migrate the pairing flow off bearer tokens", approvals = true, updatedAgo = 2),
        thread(
            "t-run",
            "Rewrite the transcript virtualiser so long threads stop dropping frames",
            provider = "claudeAgent",
            model = "claude-opus-5",
            running = true,
            updatedAgo = 4,
        ),
        thread("t-1", "Fix the onboarding flow", updatedAgo = 42),
        thread("t-2", "Audit websocket reconnect backoff", projectId = "p2", model = "claude-opus-5", updatedAgo = 3, unit = ChronoUnit.HOURS),
        thread("t-3", "Bump the Compose BOM and retest the composer", updatedAgo = 2, unit = ChronoUnit.DAYS),
    )

    private fun base() = SynaraUiState(
        screen = AppScreen.WORKSPACE,
        connection = ConnectionState.CONNECTED,
        serverUrl = "http://192.168.1.20:3773",
        hasStoredSession = true,
        projects = projects,
        threads = threads,
        models = models,
    )

    fun setup() = SynaraUiState(serverUrl = "http://192.168.1.20:3773", hasStoredSession = false)

    fun setupError() = SynaraUiState(
        serverUrl = "http://192.168.1.20:3773",
        hasStoredSession = true,
        setupError = "Synara rejected this pairing link. Generate a fresh one on your desktop.",
    )

    fun workspace() = base()

    fun workspaceSpaces() = base().copy(
        spaces = listOf(
            SpaceItem("s1", "Product", "folder", 0),
            SpaceItem("s2", "Infra", "server", 1),
        ),
        projects = projects.map { if (it.id == "p1") it.copy(spaceId = "s1") else it.copy(spaceId = "s2") },
    )

    fun workspaceEmpty() = base().copy(threads = emptyList())

    fun workspaceNoProjects() = base().copy(threads = emptyList(), projects = emptyList())

    fun workspaceLoading() = base().copy(threads = emptyList(), isLoading = true)

    fun workspaceOffline() = base().copy(connection = ConnectionState.DISCONNECTED)

    fun workspaceError() = base().copy(
        error = "The server took too long to respond.",
    )

    fun createThreadOpen() = base().copy(createThreadOpen = true, selectedProjectId = "p1")

    fun threadActions() = base().copy(threadActionsFor = "t-run")

    fun projectActions() = base().copy(projectActionsFor = "p1")

    fun workspaceArchived() = base().copy(
        showArchived = true,
        threads = threads + thread("t-old", "Retire the legacy pairing endpoint", updatedAgo = 9, unit = ChronoUnit.DAYS)
            .copy(archivedAt = ago(9, ChronoUnit.DAYS)),
    )

    fun createProjectOpen() = base().copy(createProjectOpen = true)

    private val transcript = listOf(
        MessageItem(
            "m1",
            "user",
            "The thread list drops frames once a transcript passes a few hundred messages. Can you find the cause?",
            false,
            ago(9, ChronoUnit.MINUTES),
            "t1",
        ),
        MessageItem(
            "m2",
            "assistant",
            """
            Found it. `TranscriptList` re-measures **every** row whenever a single message mutates,
            because the item key is derived from the message *body* rather than its id.

            Two changes:

            1. Key rows by `message.id` so Compose can reuse slots.
            2. Hoist `rememberMarkdown(text)` out of the row so a streamed token does not reparse
               the entire transcript.

            ```kotlin
            items(messages, key = { it.id }) { message ->
                MessageRow(message)
            }
            ```

            The second one is the expensive half — parsing was running `O(n)` times per token.
            """.trimIndent(),
            false,
            ago(8, ChronoUnit.MINUTES),
            "t1",
        ),
        MessageItem("m3", "user", "Ship it behind the existing flag.", false, ago(3, ChronoUnit.MINUTES), "t2"),
        MessageItem(
            "m4",
            "assistant",
            "Patching `TranscriptList` now — keying rows by id first, then hoisting the parse.",
            true,
            ago(1, ChronoUnit.MINUTES),
            "t2",
        ),
    )

    private val activities = listOf(
        ActivityItem("a1", "info", "turn.started", "Turn started on gpt-5.6-sol", ago(9, ChronoUnit.MINUTES), null),
        ActivityItem("a2", "info", "tool.ran", "Read apps/web/src/components/TranscriptList.tsx", ago(8, ChronoUnit.MINUTES), null),
        ActivityItem("a3", "approval", "approval.requested", "Approval requested: write 2 files", ago(4, ChronoUnit.MINUTES), null),
        ActivityItem("a4", "error", "provider.error", "Provider stream reconnected after a dropped frame", ago(2, ChronoUnit.MINUTES), null),
    )

    private fun detail(
        thread: ThreadItem,
        messages: List<MessageItem> = transcript,
        pending: List<PendingInteraction> = emptyList(),
        extraActivities: List<ActivityItem> = emptyList(),
        plan: String? = null,
    ) = ThreadDetail(
        thread = thread,
        messages = messages,
        activities = activities + extraActivities,
        pendingInteractions = pending,
        notes = null,
        proposedPlan = plan,
        sequence = 1,
    )

    fun chat(): SynaraUiState {
        val t = thread("t-run", "Rewrite the transcript virtualiser", running = true)
        return base().copy(
            screen = AppScreen.CHAT,
            selectedThreadId = t.id,
            detail = detail(
                t,
                plan = "1. Key transcript rows by message id.\n" +
                    "2. Hoist markdown parsing out of the row.\n" +
                    "3. Add a frame-timing regression test.",
            ),
        )
    }

    fun chatPlanMode(): SynaraUiState {
        val base = chat()
        val detail = base.detail!!
        return base.copy(
            detail = detail.copy(thread = detail.thread.copy(interactionMode = "plan")),
            catalogue = catalogue().catalogue,
        )
    }

    fun chatApproval(): SynaraUiState {
        val t = thread("t-approve", "Migrate the pairing flow off bearer tokens", approvals = true)
        return base().copy(
            screen = AppScreen.CHAT,
            selectedThreadId = t.id,
            detail = detail(
                t,
                messages = transcript.dropLast(1),
                pending = listOf(PendingInteraction("approval", "req-1", "gen-1", "pending", null)),
            ),
        )
    }

    fun chatQuestion(): SynaraUiState {
        val t = thread("t-ask", "Choose a persistence strategy", userInput = true)
        val questions = JSONObject()
            .put("requestId", "req-2")
            .put(
                "questions",
                JSONArray().put(
                    JSONObject()
                        .put("id", "storage")
                        .put("header", "Storage")
                        .put("question", "Where should the paired session live?")
                        .put("multiSelect", false)
                        .put(
                            "options",
                            JSONArray()
                                .put(
                                    JSONObject()
                                        .put("label", "Android Keystore")
                                        .put("description", "Hardware-backed, wiped on uninstall."),
                                )
                                .put(
                                    JSONObject()
                                        .put("label", "Encrypted DataStore")
                                        .put("description", "Portable across form factors, slower to read."),
                                ),
                        ),
                ),
            )
        return base().copy(
            screen = AppScreen.CHAT,
            selectedThreadId = t.id,
            detail = detail(
                t,
                messages = transcript.take(2),
                pending = listOf(PendingInteraction("userInput", "req-2", "gen-1", "pending", null)),
                extraActivities = listOf(
                    ActivityItem(
                        "a5",
                        "approval",
                        "user-input.requested",
                        "The agent asked a question",
                        ago(1, ChronoUnit.MINUTES),
                        questions,
                    ),
                ),
            ),
        )
    }

    fun chatEmpty(): SynaraUiState {
        val t = thread("t-new", "Investigate the flaky pairing test")
        return base().copy(
            screen = AppScreen.CHAT,
            selectedThreadId = t.id,
            detail = ThreadDetail(t, emptyList(), emptyList(), emptyList(), null, null, 1),
        )
    }

    fun settings() = base().copy(screen = AppScreen.SETTINGS)

    fun kanban() = base().copy(screen = AppScreen.KANBAN)

    fun catalogue() = base().copy(
        screen = AppScreen.CATALOGUE,
        catalogue = CatalogueState(
            providerLabel = "Codex",
            catalogue = ProviderCatalogue(
                skills = listOf(
                    CatalogueEntry("react-doctor", "Scan, triage and clean up React diagnostics.", "/repo/.claude/skills/react-doctor", "repo", true),
                    CatalogueEntry("dataviz", "Design charts that read as one system.", "/home/me/.claude/skills/dataviz", "global", true),
                    CatalogueEntry("verify", "Run Synara locally for runtime verification.", "/repo/.claude/skills/verify", "repo", false),
                ),
                commands = listOf(
                    CatalogueEntry("review", "Review the working diff.", null, null, true),
                    CatalogueEntry("init", "Write a CLAUDE.md for this repository.", null, null, true),
                ),
                agents = listOf(
                    CatalogueEntry("explore", "Read-only codebase explorer.", null, "builtin", true),
                    CatalogueEntry("build", "Implementation teammate for scoped changes.", null, "builtin", true),
                ),
            ),
        ),
    )

    private const val E = "\u001B"

    val TERMINAL_OUTPUT: String = buildString {
        append("${'$'} bun run test\n")
        append("$E[2m\u0024 vitest run --reporter=dot$E[0m\n")
        append("\n")
        append("$E[32m ✓ $E[0mpackages/shared/src/model.test.ts $E[2m(24 tests) 118ms$E[0m\n")
        append("$E[32m ✓ $E[0mapps/server/src/providerManager.test.ts $E[2m(61 tests) 942ms$E[0m\n")
        append("$E[31m ✗ $E[0mapps/web/src/components/DiffPanel.logic.test.ts\n")
        append("   $E[31m→ expected 3 files, received 2$E[0m\n")
        append("\n")
        append("$E[1mTest Files$E[0m  $E[31m1 failed$E[0m | $E[32m42 passed$E[0m (43)\n")
        append("$E[1m     Tests$E[0m  $E[31m1 failed$E[0m | $E[32m téléchargement 1204 passed$E[0m\n")
        append("Downloading 10%\rDownloading 64%\rDownloading 100%$E[K\n")
        append("${'$'} ")
    }

    fun terminal(): SynaraUiState {
        val t = thread("t-run", "Rewrite the transcript virtualiser")
        return base().copy(
            screen = AppScreen.TERMINAL,
            selectedThreadId = t.id,
            detail = detail(t),
            terminal = TerminalState(
                threadId = t.id,
                cwd = "/home/me/projects/synara",
                snapshot = TerminalSnapshot(t.id, "default", "/home/me/projects/synara", "running", 4821, "", null),
                revision = 1,
            ),
        )
    }

    private fun automation(
        id: String,
        name: String,
        scheduleType: String,
        everySeconds: Int? = null,
        timeOfDay: String? = null,
        enabled: Boolean = true,
        mode: AutomationMode = AutomationMode.STANDALONE,
        proposal: Boolean = false,
        iterations: Int = 12,
        maxIterations: Int? = null,
    ) = Automation(
        id = id,
        projectId = "p1",
        name = name,
        prompt = "Check the open pull requests for failing CI and summarise anything that needs a human.",
        schedule = AutomationSchedule(scheduleType, everySeconds, timeOfDay, 1, null, null, null),
        enabled = enabled,
        nextRunAt = ago(-30, ChronoUnit.MINUTES),
        mode = mode,
        provider = "codex",
        model = "gpt-5.6-sol",
        runtimeMode = "approval-required",
        maxIterations = maxIterations,
        iterationCount = iterations,
        stopOnError = true,
        proposalState = if (proposal) "pending" else null,
        archivedAt = null,
        updatedAt = ago(20, ChronoUnit.MINUTES),
    )

    private fun run(
        id: String,
        automationId: String,
        status: String,
        outcome: String? = null,
        title: String? = null,
        unread: Boolean = false,
        agoMinutes: Long = 30,
        error: String? = null,
    ) = AutomationRun(
        id = id,
        automationId = automationId,
        threadId = "t-1",
        status = status,
        trigger = "scheduled",
        scheduledFor = ago(agoMinutes, ChronoUnit.MINUTES),
        startedAt = ago(agoMinutes, ChronoUnit.MINUTES),
        finishedAt = if (status == "running") null else ago(agoMinutes - 2, ChronoUnit.MINUTES),
        outcome = outcome,
        title = title,
        summary = title,
        severity = if (status == "failed") "error" else null,
        unread = unread,
        error = error,
    )

    private fun automationList() = AutomationList(
        definitions = listOf(
            automation("a-pr", "Watch PR 512 CI", "interval", everySeconds = 1800),
            automation("a-sweep", "Morning dependency sweep", "daily", timeOfDay = "06:00", mode = AutomationMode.DEDICATED, maxIterations = 30),
            automation("a-paused", "Weekly changelog draft", "weekly", timeOfDay = "09:00", enabled = false, iterations = 4),
            automation("a-prop", "Triage new issues hourly", "interval", everySeconds = 3600, proposal = true, enabled = false, iterations = 0),
        ),
        runs = listOf(
            run("r1", "a-pr", "running", agoMinutes = 3),
            run("r2", "a-pr", "succeeded", outcome = "findings", title = "2 checks failing on PR 512", unread = true, agoMinutes = 33),
            run("r3", "a-sweep", "succeeded", outcome = "no-findings", title = "No outdated dependencies", agoMinutes = 400),
            run("r4", "a-paused", "failed", title = "Could not reach the changelog service", agoMinutes = 2000, error = "ECONNREFUSED api.internal:443"),
        ),
    )

    fun automations() = base().copy(
        screen = AppScreen.AUTOMATIONS,
        automations = AutomationsState(list = automationList()),
    )

    fun automationDetail() = base().copy(
        screen = AppScreen.AUTOMATIONS,
        automations = AutomationsState(list = automationList(), selectedId = "a-pr"),
    )

    private val samplePatch = """
        diff --git a/apps/web/src/components/TranscriptList.tsx b/apps/web/src/components/TranscriptList.tsx
        index 1111111..2222222 100644
        --- a/apps/web/src/components/TranscriptList.tsx
        +++ b/apps/web/src/components/TranscriptList.tsx
        @@ -42,9 +42,9 @@ export function TranscriptList({ messages }: Props) {
           const virtualizer = useVirtualizer({
             count: messages.length,
        -    getItemKey: (index) => hash(messages[index].text),
        +    getItemKey: (index) => messages[index].id,
             estimateSize: () => 96,
           });
        @@ -88,6 +88,7 @@ export function TranscriptList({ messages }: Props) {
           return (
             <div ref={parentRef} className="h-full overflow-auto">
        +      {/* Rows are keyed by id so Compose can reuse slots across a stream. */}
               {items.map((item) => (
                 <MessageRow key={item.key} message={messages[item.index]} />
               ))}
        diff --git a/apps/web/src/lib/markdownCache.ts b/apps/web/src/lib/markdownCache.ts
        new file mode 100644
        --- /dev/null
        +++ b/apps/web/src/lib/markdownCache.ts
        @@ -0,0 +1,6 @@
        +const cache = new Map<string, ParsedMarkdown>();
        +
        +export function rememberMarkdown(text: string): ParsedMarkdown {
        +  const hit = cache.get(text);
        +  return hit ?? parse(text);
        +}
        diff --git a/apps/web/src/lib/legacyDiffCache.ts b/apps/web/src/lib/legacyDiffCache.ts
        deleted file mode 100644
        --- a/apps/web/src/lib/legacyDiffCache.ts
        +++ /dev/null
        @@ -1,3 +0,0 @@
        -export const legacyCache = new Map();
        -// Superseded by markdownCache.
        -export default legacyCache;
        diff --git a/docs/perf.png b/docs/perf.png
        index 3333333..4444444 100644
        Binary files a/docs/perf.png and b/docs/perf.png differ
    """.trimIndent()

    fun diff(): SynaraUiState {
        val t = thread("t-run", "Rewrite the transcript virtualiser", running = false)
        return base().copy(
            screen = AppScreen.DIFF,
            selectedThreadId = t.id,
            detail = detail(t),
            diff = DiffState(
                scope = DiffScope.THREAD,
                parsed = parseUnifiedDiff(samplePatch),
                expanded = setOf("apps/web/src/components/TranscriptList.tsx"),
            ),
        )
    }

    private fun gitState(branchPickerOpen: Boolean = false) = SourceControlState(
        cwd = "/home/me/projects/synara",
        status = GitStatus(
            branch = "agent/transcript-virtualiser",
            hasWorkingTreeChanges = true,
            files = listOf(
                GitFileChange("apps/web/src/components/TranscriptList.tsx", 2, 1),
                GitFileChange("apps/web/src/lib/markdownCache.ts", 6, 0),
                GitFileChange("apps/web/src/lib/legacyDiffCache.ts", 0, 3),
            ),
            insertions = 8,
            deletions = 4,
            hasUpstream = true,
            upstreamBranch = "origin/agent/transcript-virtualiser",
            aheadCount = 2,
            behindCount = 1,
            pullRequest = GitPullRequestInfo(
                number = 512,
                title = "Key transcript rows by message id",
                url = "https://github.com/octanethegenio/synara/pull/512",
                baseBranch = "main",
                headBranch = "agent/transcript-virtualiser",
                state = "open",
                isDraft = false,
                mergeability = "mergeable",
                additions = 8,
                deletions = 4,
                changedFiles = 3,
            ),
        ),
        branches = GitBranches(
            branches = listOf(
                GitBranchItem("agent/transcript-virtualiser", isCurrent = true, isDefault = false, isRemote = false, remoteName = null, worktreePath = null),
                GitBranchItem("main", isCurrent = false, isDefault = true, isRemote = false, remoteName = null, worktreePath = null),
                GitBranchItem("agent/pairing-flow", isCurrent = false, isDefault = false, isRemote = false, remoteName = null, worktreePath = "/home/me/worktrees/pairing"),
                GitBranchItem("origin/main", isCurrent = false, isDefault = false, isRemote = true, remoteName = "origin", worktreePath = null),
            ),
            isRepo = true,
            hasOriginRemote = true,
        ),
        commitMessage = "Key transcript rows by message id",
        branchPickerOpen = branchPickerOpen,
    )

    fun sourceControl(): SynaraUiState {
        val t = thread("t-run", "Rewrite the transcript virtualiser")
        return base().copy(
            screen = AppScreen.SOURCE_CONTROL,
            selectedThreadId = t.id,
            detail = detail(t),
            git = gitState(),
        )
    }

    fun pullRequest(): SynaraUiState {
        val pr = gitState().status!!.pullRequest!!
        return sourceControl().copy(
            screen = AppScreen.PULL_REQUEST,
            pullRequest = PullRequestState(
                snapshot = PullRequestSnapshot(
                    pullRequest = pr,
                    checks = listOf(
                        GitCheck("build / android", CheckStatus.SUCCESS, "https://ci/1"),
                        GitCheck("test / vitest", CheckStatus.FAILURE, "https://ci/2"),
                        GitCheck("lint / oxlint", CheckStatus.SUCCESS, null),
                        GitCheck("e2e / playwright", CheckStatus.PENDING, "https://ci/4"),
                        GitCheck("bundle-size", CheckStatus.SKIPPED, null),
                    ),
                    comments = listOf(
                        GitReviewComment(
                            "c1",
                            "dana",
                            "This still reparses on every token. Can we hoist `rememberMarkdown` " +
                                "out of the row?\n\n```ts\nconst parsed = useMemo(() => parse(text), [text]);\n```",
                            "apps/web/src/components/TranscriptList.tsx",
                            "https://github.com/x/y/pull/512#discussion_r1",
                            ago(2, ChronoUnit.HOURS),
                        ),
                        GitReviewComment(
                            "c2",
                            "sam",
                            "Nit: the **key** should be stable across reorders too.",
                            null,
                            null,
                            ago(40, ChronoUnit.MINUTES),
                        ),
                    ),
                    commentsTruncated = true,
                    commentsError = null,
                ),
            ),
        )
    }

    fun sourceControlBranches(): SynaraUiState = sourceControl().copy(git = gitState(branchPickerOpen = true))

    fun diffEmpty(): SynaraUiState {
        val t = thread("t-run", "Rewrite the transcript virtualiser")
        return base().copy(
            screen = AppScreen.DIFF,
            selectedThreadId = t.id,
            detail = detail(t),
            diff = DiffState(scope = DiffScope.WORKING_TREE, parsed = parseUnifiedDiff("")),
        )
    }
}
