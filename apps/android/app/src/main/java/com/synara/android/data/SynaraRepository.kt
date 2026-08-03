package com.synara.android.data

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

sealed interface RepositoryEvent {
    data class ConnectionChanged(val state: ConnectionState) : RepositoryEvent
    data class ThreadSnapshot(val detail: ThreadDetail) : RepositoryEvent
    data class ThreadEvent(val threadId: String, val event: JSONObject) : RepositoryEvent
    data class ShellChanged(val snapshot: WorkspaceSnapshot) : RepositoryEvent
    data class Error(val message: String) : RepositoryEvent
}

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
}

class AuthRequiredException(message: String) : IOException(message)

class SynaraRepository(context: Context) {
    private val store = SecureSessionStore(context.applicationContext)
    private val http = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private val requestIds = AtomicLong(1)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject?>>()
    private val streams = ConcurrentHashMap<String, (JSONObject) -> Unit>()
    private val streamCompletions = ConcurrentHashMap<String, () -> Unit>()
    private val events = kotlinx.coroutines.flow.MutableSharedFlow<RepositoryEvent>(
        extraBufferCapacity = 64,
    )
    private val backgroundScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val shellRefreshInFlight = AtomicBoolean(false)

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var baseUrl: HttpUrl? = null

    @Volatile
    private var sessionToken: String? = null

    fun events() = events

    fun storedSession(): StoredSession? = store.readSession()

    suspend fun connectWithPairing(serverUrlInput: String, pairingInput: String) {
        val serverUrl = normalizeBaseUrl(serverUrlInput)
        val credential = extractPairingCredential(pairingInput)
        require(credential.isNotBlank()) { "Paste a Synara pairing link or token." }

        closeSocket()
        setConnectionState(ConnectionState.CONNECTING)
        baseUrl = serverUrl
        val result = postJson(
            serverUrl,
            "/api/auth/bootstrap/bearer",
            JSONObject().put("credential", credential),
        )
        val token = result.stringOrNull("sessionToken")
            ?: throw IOException("The server did not return a session token.")
        store.saveBaseUrl(serverUrl.toString().trimEnd('/'))
        store.saveSessionToken(token)
        sessionToken = token
        openAuthenticatedSocket(serverUrl, token)
    }

    suspend fun reconnectStored() {
        val stored = store.readSession() ?: throw AuthRequiredException("Pair this phone with Synara first.")
        closeSocket()
        setConnectionState(ConnectionState.CONNECTING)
        baseUrl = normalizeBaseUrl(stored.baseUrl)
        sessionToken = stored.sessionToken
        openAuthenticatedSocket(baseUrl!!, stored.sessionToken)
    }

    suspend fun refreshWorkspace(): WorkspaceSnapshot {
        val snapshot = WorkspaceSnapshot.fromJson(
            rpc("orchestration.getShellSnapshot", JSONObject()) ?: JSONObject(),
        )
        events.tryEmit(RepositoryEvent.ShellChanged(snapshot))
        return snapshot
    }

    suspend fun loadThread(threadId: String): ThreadDetail? {
        val response = rpc(
            "orchestration.getThreadDetailSnapshot",
            JSONObject().put("threadId", threadId),
        ) ?: return null
        val detail = ThreadDetail.fromSnapshot(response)
        if (detail != null) events.tryEmit(RepositoryEvent.ThreadSnapshot(detail))
        return detail
    }

    suspend fun subscribeThread(threadId: String): String = streamRpc(
        "orchestration.subscribeThread",
        JSONObject().put("threadId", threadId),
    ) { item ->
        when (item.stringOrNull("kind")) {
            "snapshot" -> item.objectOrNull("snapshot")?.let { snapshot ->
                ThreadDetail.fromSnapshot(snapshot)?.let {
                    events.tryEmit(RepositoryEvent.ThreadSnapshot(it))
                }
            }
            "event" -> item.objectOrNull("event")?.let {
                events.tryEmit(RepositoryEvent.ThreadEvent(threadId, it))
            }
        }
    }

    suspend fun subscribeShell(): String = streamRpc(
        "orchestration.subscribeShell",
        JSONObject(),
    ) { item ->
        when (item.stringOrNull("kind")) {
            "snapshot" -> item.objectOrNull("snapshot")?.let {
                events.tryEmit(RepositoryEvent.ShellChanged(WorkspaceSnapshot.fromJson(it)))
            }
            else -> {
                // Shell events deliberately trigger a fresh compact snapshot. This keeps the
                // mobile projection simple and authoritative while the selected thread uses
                // event-level updates for smooth assistant streaming.
                if (shellRefreshInFlight.compareAndSet(false, true)) {
                    backgroundScope.launch {
                        try {
                            refreshWorkspace()
                        } finally {
                            shellRefreshInFlight.set(false)
                        }
                    }
                }
            }
        }
    }

    fun stopStream(requestId: String) {
        streams.remove(requestId)
        streamCompletions.remove(requestId)
        sendFrame(JSONObject().put("_tag", "Interrupt").put("requestId", requestId))
    }

    /**
     * Uploads attachment bytes and returns the descriptor the turn command references.
     *
     * Bytes go over HTTP rather than the WebSocket: the RPC frame carries only metadata (id, name,
     * mime type, size), and pushing a multi-megabyte image through the same socket that streams
     * assistant tokens would stall the transcript behind it.
     */
    suspend fun uploadAttachment(
        threadId: String,
        name: String,
        mimeType: String,
        bytes: ByteArray,
    ): JSONObject = withContext(Dispatchers.IO) {
        val base = baseUrl ?: throw IOException("Not connected to Synara.")
        val token = sessionToken ?: throw AuthRequiredException("Pair this phone with Synara again.")
        val type = if (mimeType.startsWith("image/", ignoreCase = true)) "image" else "file"
        val url = base.newBuilder()
            .encodedPath("/api/attachments/upload")
            .addQueryParameter("type", type)
            .addQueryParameter("threadId", threadId)
            .addQueryParameter("name", name)
            .addQueryParameter("mimeType", mimeType)
            .build()
        val response = executeRequest(
            Request.Builder()
                .url(url)
                .post(bytes.toRequestBody(mimeType.toMediaType()))
                .header("Authorization", "Bearer $token")
                .build(),
        ).body
        // The server assigns the id; everything else is echoed back so the descriptor the turn
        // references is the server's, not the phone's guess at it.
        JSONObject()
            .put("type", response.stringOrNull("type") ?: type)
            .put("id", response.stringOrNull("id") ?: response.stringOrNull("attachmentId").orEmpty())
            .put("name", response.stringOrNull("name") ?: name)
            .put("mimeType", response.stringOrNull("mimeType") ?: mimeType)
            .put("sizeBytes", if (response.has("sizeBytes")) response.optInt("sizeBytes") else bytes.size)
    }

    suspend fun sendMessage(
        thread: ThreadItem,
        text: String,
        messageId: String,
        attachments: List<JSONObject> = emptyList(),
    ) {
        dispatch("thread.turn.start") {
            put("threadId", thread.id)
            put(
                "message",
                JSONObject()
                    .put("messageId", messageId)
                    .put("role", "user")
                    .put("text", text)
                    .put("attachments", JSONArray(attachments)),
            )
            put("runtimeMode", thread.runtimeMode)
            put("interactionMode", thread.interactionMode)
            put("dispatchMode", "queue")
            put("createdAt", nowIso())
        }
    }

    suspend fun interruptThread(thread: ThreadItem) {
        dispatch("thread.turn.interrupt") {
            put("threadId", thread.id)
            put("createdAt", nowIso())
            thread.activeTurnId?.let { put("turnId", it) }
        }
    }

    suspend fun respondToApproval(threadId: String, interaction: PendingInteraction, decision: String) {
        dispatch("thread.approval.respond") {
            put("threadId", threadId)
            put("requestId", interaction.requestId)
            put("decision", decision)
            put("createdAt", nowIso())
            interaction.lifecycleGeneration?.let { put("lifecycleGeneration", it) }
        }
    }

    suspend fun respondToUserInput(
        threadId: String,
        interaction: PendingInteraction,
        answers: JSONObject,
    ) {
        dispatch("thread.user-input.respond") {
            put("threadId", threadId)
            put("requestId", interaction.requestId)
            put("answers", answers)
            put("createdAt", nowIso())
            interaction.lifecycleGeneration?.let { put("lifecycleGeneration", it) }
        }
    }

    suspend fun createProject(
        title: String,
        workspaceRoot: String,
        model: ModelOption,
        createRootIfMissing: Boolean = false,
    ) {
        dispatch("project.create") {
            put("projectId", newId())
            put("kind", "project")
            put("title", title)
            put("workspaceRoot", workspaceRoot)
            put("createWorkspaceRootIfMissing", createRootIfMissing)
            put("defaultModelSelection", modelSelectionJson(model))
            put("isPinned", false)
            put("createdAt", nowIso())
        }
    }

    suspend fun updateProjectMeta(
        projectId: String,
        title: String? = null,
        workspaceRoot: String? = null,
        isPinned: Boolean? = null,
        defaultModel: ModelOption? = null,
    ) {
        dispatch("project.meta.update") {
            put("projectId", projectId)
            title?.let { put("title", it) }
            workspaceRoot?.let { put("workspaceRoot", it) }
            isPinned?.let { put("isPinned", it) }
            defaultModel?.let { put("defaultModelSelection", modelSelectionJson(it)) }
        }
    }

    suspend fun deleteProject(projectId: String) {
        dispatch("project.delete") { put("projectId", projectId) }
    }

    suspend fun createThread(
        project: ProjectItem,
        title: String,
        model: ModelOption,
        runtimeMode: String,
        interactionMode: String = InteractionMode.DEFAULT.wire,
    ): String {
        val threadId = newId()
        dispatch("thread.create") {
            put("threadId", threadId)
            put("projectId", project.id)
            put("title", title)
            put("modelSelection", modelSelectionJson(model))
            put("runtimeMode", runtimeMode)
            put("interactionMode", interactionMode)
            put("envMode", "local")
            put("branch", JSONObject.NULL)
            put("worktreePath", JSONObject.NULL)
            put("workingDirectory", project.workspaceRoot)
            put("isPinned", false)
            put("parentThreadId", JSONObject.NULL)
            put("createdAt", nowIso())
        }
        return threadId
    }

    // ── Thread lifecycle ─────────────────────────────────────────────────────────────────────

    suspend fun archiveThread(threadId: String) {
        dispatch("thread.archive") { put("threadId", threadId) }
    }

    suspend fun unarchiveThread(threadId: String) {
        dispatch("thread.unarchive") { put("threadId", threadId) }
    }

    suspend fun deleteThread(threadId: String) {
        dispatch("thread.delete") { put("threadId", threadId) }
    }

    /**
     * `thread.meta.update` is a sparse patch: every field is optional and omitting one leaves it
     * untouched, so callers pass only what they are changing.
     */
    suspend fun updateThreadMeta(
        threadId: String,
        title: String? = null,
        isPinned: Boolean? = null,
        model: ModelOption? = null,
    ) {
        dispatch("thread.meta.update") {
            put("threadId", threadId)
            title?.let { put("title", it) }
            isPinned?.let { put("isPinned", it) }
            model?.let { put("modelSelection", modelSelectionJson(it)) }
        }
    }

    suspend fun setRuntimeMode(threadId: String, runtimeMode: String) {
        dispatch("thread.runtime-mode.set") {
            put("threadId", threadId)
            put("runtimeMode", runtimeMode)
            put("createdAt", nowIso())
        }
    }

    suspend fun setInteractionMode(threadId: String, interactionMode: String) {
        dispatch("thread.interaction-mode.set") {
            put("threadId", threadId)
            put("interactionMode", interactionMode)
            put("createdAt", nowIso())
        }
    }

    // ── Diffs ────────────────────────────────────────────────────────────────────────────────

    /**
     * Everything the agent changed across the whole thread, up to [toTurnCount].
     *
     * The diff RPCs address turns by *count*, not id, and the only place a client can read that
     * count is the checkpoint list on the thread snapshot — see [ThreadDetail.latestTurnCount].
     */
    suspend fun getFullThreadDiff(threadId: String, toTurnCount: Int): String =
        rpc(
            "orchestration.getFullThreadDiff",
            JSONObject()
                .put("threadId", threadId)
                .put("toTurnCount", toTurnCount)
                .put("ignoreWhitespace", false),
        )?.stringOrNull("diff").orEmpty()

    /** What changed in a single turn: the span between its checkpoint and the one before it. */
    suspend fun getTurnDiff(threadId: String, fromTurnCount: Int, toTurnCount: Int): String =
        rpc(
            "orchestration.getTurnDiff",
            JSONObject()
                .put("threadId", threadId)
                .put("fromTurnCount", fromTurnCount)
                .put("toTurnCount", toTurnCount)
                .put("ignoreWhitespace", false),
        )?.stringOrNull("diff").orEmpty()

    /**
     * Uncommitted changes in a checkout. Scope maps to git's own staging distinction:
     * `workingTree` (everything), `staged`, `unstaged`, or `branch` (versus the merge base).
     */
    suspend fun readWorkingTreeDiff(cwd: String, scope: String = "workingTree"): String =
        rpc(
            "git.readWorkingTreeDiff",
            JSONObject().put("cwd", cwd).put("scope", scope),
        )?.stringOrNull("patch").orEmpty()

    // ── Server settings ──────────────────────────────────────────────────────────────────────

    suspend fun getServerSettings(): ServerSettings =
        ServerSettings.fromJson(rpc("server.getSettings", JSONObject()) ?: JSONObject())

    /**
     * `ServerSettingsPatch` is sparse by design: omitted keys are left alone. Sending the whole
     * settings object back would make the phone clobber fields it never rendered, including
     * per-provider options it has no UI for.
     */
    suspend fun updateServerSettings(patch: JSONObject): ServerSettings =
        ServerSettings.fromJson(rpc("server.updateSettings", patch) ?: JSONObject())

    suspend fun providerStatuses(refresh: Boolean = false): List<ProviderStatus> {
        val tag = if (refresh) "server.refreshProviders" else "server.getConfig"
        val response = rpc(tag, JSONObject()) ?: return emptyList()
        return response.arrayOrEmpty("providerStatuses").objects().mapNotNull(ProviderStatus::fromJson)
            .ifEmpty { response.arrayOrEmpty("providers").objects().mapNotNull(ProviderStatus::fromJson) }
    }

    suspend fun listProviderUsage(forceRefresh: Boolean = false): List<ProviderUsage> {
        val response = rpc(
            "server.listProviderUsage",
            JSONObject().put("forceRefresh", forceRefresh),
        ) ?: return emptyList()
        // The result is a bare array; the transport wraps a non-object exit value under "value".
        return response.arrayOrEmpty("value").objects().mapNotNull(ProviderUsage::fromJson)
            .ifEmpty { response.arrayOrEmpty("usage").objects().mapNotNull(ProviderUsage::fromJson) }
    }

    // ── Spaces ───────────────────────────────────────────────────────────────────────────────

    suspend fun createSpace(name: String, icon: String = "folder") {
        dispatch("space.create") {
            put("spaceId", newId())
            put("name", name)
            put("icon", icon)
            put("createdAt", nowIso())
        }
    }

    suspend fun renameSpace(spaceId: String, name: String) {
        dispatch("space.meta.update") {
            put("spaceId", spaceId)
            put("name", name)
        }
    }

    suspend fun deleteSpace(spaceId: String) {
        dispatch("space.delete") { put("spaceId", spaceId) }
    }

    /**
     * Bulk-files projects into a space in one transaction. Moving a project *out* of a space is
     * deliberately not this call — the contract routes that through `project.meta.update` with a
     * null space, and mirroring that split keeps the atomic bulk path meaning exactly one thing.
     */
    suspend fun assignProjectsToSpace(spaceId: String, projectIds: List<String>) {
        if (projectIds.isEmpty()) return
        dispatch("space.projects.assign") {
            put("spaceId", spaceId)
            put("projectIds", JSONArray(projectIds))
        }
    }

    suspend fun moveProjectToVoid(projectId: String) {
        dispatch("project.meta.update") {
            put("projectId", projectId)
            put("spaceId", JSONObject.NULL)
        }
    }

    // ── Studio ───────────────────────────────────────────────────────────────────────────────

    /** Files a thread produced into the Studio workspace. */
    suspend fun listStudioOutputs(threadId: String): List<StudioOutput> =
        rpc("studio.listThreadOutputs", JSONObject().put("threadId", threadId))
            ?.arrayOrEmpty("entries")
            ?.objects()
            ?.map(StudioOutput::fromJson)
            .orEmpty()

    // ── Provider catalogue ───────────────────────────────────────────────────────────────────

    /**
     * Skills, slash commands and subagents available to a thread.
     *
     * All three are per-provider *and* per-checkout: a skill in the repository's `.claude/skills`
     * only exists for a thread rooted there. Fetching them together keeps the three lists
     * consistent with each other, which matters because the composer offers them side by side.
     */
    suspend fun loadCatalogue(provider: String, cwd: String, threadId: String?): ProviderCatalogue =
        withContext(Dispatchers.IO) {
            fun payload() = JSONObject()
                .put("provider", provider)
                .put("cwd", cwd)
                .apply { threadId?.let { put("threadId", it) } }

            // A provider that does not implement one of these fails only that list; the others
            // still populate rather than the whole screen erroring.
            val skills = async { runCatching { rpc("provider.listSkills", payload()) }.getOrNull() }
            val commands = async { runCatching { rpc("provider.listCommands", payload()) }.getOrNull() }
            val agents = async { runCatching { rpc("provider.listAgents", payload()) }.getOrNull() }

            ProviderCatalogue(
                skills = skills.await()?.arrayOrEmpty("skills")?.objects()?.map(CatalogueEntry::skill).orEmpty(),
                commands = commands.await()?.arrayOrEmpty("commands")?.objects()?.map(CatalogueEntry::command).orEmpty(),
                agents = agents.await()?.arrayOrEmpty("agents")?.objects()?.map(CatalogueEntry::agent).orEmpty(),
            )
        }

    // ── Terminal ─────────────────────────────────────────────────────────────────────────────

    /**
     * Opens (or re-attaches to) a PTY for a thread and returns its snapshot, whose `history` field
     * holds the scrollback produced before this client connected — without replaying it the phone
     * would show a blank terminal for a session that has been running for an hour.
     */
    suspend fun openTerminal(
        threadId: String,
        cwd: String,
        terminalId: String = DEFAULT_TERMINAL_ID,
        cols: Int = 80,
        rows: Int = 24,
    ): TerminalSnapshot = TerminalSnapshot.fromJson(
        rpc(
            "terminal.open",
            JSONObject()
                .put("threadId", threadId)
                .put("terminalId", terminalId)
                .put("cwd", cwd)
                .put("cols", cols)
                .put("rows", rows)
                .put("streamOutput", true),
        ) ?: JSONObject(),
    )

    suspend fun writeTerminal(threadId: String, data: String, terminalId: String = DEFAULT_TERMINAL_ID) {
        if (data.isEmpty()) return
        rpc(
            "terminal.write",
            JSONObject().put("threadId", threadId).put("terminalId", terminalId).put("data", data),
        )
    }

    suspend fun resizeTerminal(
        threadId: String,
        cols: Int,
        rows: Int,
        terminalId: String = DEFAULT_TERMINAL_ID,
    ) {
        rpc(
            "terminal.resize",
            JSONObject()
                .put("threadId", threadId)
                .put("terminalId", terminalId)
                .put("cols", cols.coerceIn(TERMINAL_MIN_COLS, TERMINAL_MAX_COLS))
                .put("rows", rows.coerceIn(TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)),
        )
    }

    suspend fun clearTerminal(threadId: String, terminalId: String = DEFAULT_TERMINAL_ID) {
        rpc("terminal.clear", JSONObject().put("threadId", threadId).put("terminalId", terminalId))
    }

    suspend fun restartTerminal(
        threadId: String,
        cwd: String,
        cols: Int = 80,
        rows: Int = 24,
        terminalId: String = DEFAULT_TERMINAL_ID,
    ) {
        rpc(
            "terminal.restart",
            JSONObject()
                .put("threadId", threadId)
                .put("terminalId", terminalId)
                .put("cwd", cwd)
                .put("cols", cols)
                .put("rows", rows),
        )
    }

    suspend fun closeTerminal(threadId: String, terminalId: String = DEFAULT_TERMINAL_ID) {
        rpc(
            "terminal.close",
            JSONObject().put("threadId", threadId).put("terminalId", terminalId),
        )
    }

    /** Streams every terminal event; callers filter to the session they are showing. */
    suspend fun subscribeTerminalEvents(onEvent: (JSONObject) -> Unit): String =
        streamRpc("terminal.subscribeEvents", JSONObject(), onEvent)

    // ── Automations ──────────────────────────────────────────────────────────────────────────

    suspend fun listAutomations(projectId: String? = null, includeArchived: Boolean = false): AutomationList {
        val payload = JSONObject().put("includeArchived", includeArchived)
        projectId?.let { payload.put("projectId", it) }
        return AutomationList.fromJson(rpc("automation.list", payload) ?: JSONObject())
    }

    suspend fun runAutomationNow(automationId: String) {
        rpc("automation.runNow", JSONObject().put("automationId", automationId))
    }

    suspend fun cancelAutomationRun(runId: String) {
        rpc("automation.cancelRun", JSONObject().put("runId", runId))
    }

    suspend fun markAutomationRunRead(runId: String, unread: Boolean) {
        rpc("automation.markRunRead", JSONObject().put("runId", runId).put("unread", unread))
    }

    suspend fun archiveAutomationRun(runId: String, archived: Boolean) {
        rpc("automation.archiveRun", JSONObject().put("runId", runId).put("archived", archived))
    }

    suspend fun setAutomationEnabled(automationId: String, enabled: Boolean) {
        rpc("automation.update", JSONObject().put("id", automationId).put("enabled", enabled))
    }

    suspend fun deleteAutomation(automationId: String) {
        rpc("automation.delete", JSONObject().put("id", automationId))
    }

    /**
     * Accepting or dismissing an agent-proposed automation. Proposals stay disabled until
     * resolved, so this is the only path that turns one into a live schedule.
     */
    suspend fun resolveAutomationProposal(automationId: String, accept: Boolean) {
        rpc(
            "automation.resolveProposal",
            JSONObject()
                .put("automationId", automationId)
                .put("state", if (accept) "accepted" else "dismissed"),
        )
    }

    suspend fun getAutomationMemory(automationId: String): String? =
        rpc("automation.getMemory", JSONObject().put("automationId", automationId))
            ?.let { it.stringOrNull("memory") ?: it.objectOrNull("memory")?.stringOrNull("memory") }

    suspend fun createAutomation(
        projectId: String,
        name: String,
        prompt: String,
        schedule: JSONObject,
        model: ModelOption,
        mode: AutomationMode,
        runtimeMode: RuntimeMode,
        maxIterations: Int?,
    ) {
        val payload = JSONObject()
            .put("projectId", projectId)
            .put("name", name)
            .put("prompt", prompt)
            .put("schedule", schedule)
            .put("modelSelection", modelSelectionJson(model))
            .put("mode", mode.wire)
            .put("runtimeMode", runtimeMode.wire)
            .put("enabled", true)
        maxIterations?.let { payload.put("maxIterations", it) }
        rpc("automation.create", payload)
    }

    // ── Git ──────────────────────────────────────────────────────────────────────────────────

    suspend fun gitStatus(cwd: String): GitStatus =
        GitStatus.fromJson(rpc("git.status", JSONObject().put("cwd", cwd)) ?: JSONObject())

    /**
     * Live CI and unresolved review comments for a pull request.
     *
     * Kept separate from `git.status`, which only reports the PR's identity. Checks and comments
     * come from GitHub over the network and are slow enough that folding them into the status read
     * would stall the whole source-control screen behind them.
     */
    suspend fun pullRequestSnapshot(cwd: String, reference: String): PullRequestSnapshot? =
        PullRequestSnapshot.fromJson(
            rpc(
                "git.pullRequestSnapshot",
                JSONObject().put("cwd", cwd).put("reference", reference),
            ) ?: JSONObject(),
        )

    suspend fun listBranches(cwd: String): GitBranches =
        GitBranches.fromJson(rpc("git.listBranches", JSONObject().put("cwd", cwd)) ?: JSONObject())

    suspend fun checkout(cwd: String, branch: String) {
        rpc("git.checkout", JSONObject().put("cwd", cwd).put("branch", branch))
    }

    /**
     * Checkout that parks uncommitted work first. Plain `git.checkout` refuses to move when the
     * tree is dirty, and losing an agent's in-progress edits to a branch switch is not recoverable
     * from a phone.
     */
    suspend fun stashAndCheckout(cwd: String, branch: String) {
        rpc("git.stashAndCheckout", JSONObject().put("cwd", cwd).put("branch", branch))
    }

    suspend fun createBranch(cwd: String, branch: String, publish: Boolean = false) {
        rpc(
            "git.createBranch",
            JSONObject().put("cwd", cwd).put("branch", branch).put("publish", publish),
        )
    }

    suspend fun pull(cwd: String): String =
        rpc("git.pull", JSONObject().put("cwd", cwd))?.stringOrNull("status") ?: "pulled"

    suspend fun stageFiles(cwd: String, paths: List<String>) {
        if (paths.isEmpty()) return
        rpc("git.stageFiles", JSONObject().put("cwd", cwd).put("paths", JSONArray(paths)))
    }

    suspend fun unstageFiles(cwd: String, paths: List<String>) {
        if (paths.isEmpty()) return
        rpc("git.unstageFiles", JSONObject().put("cwd", cwd).put("paths", JSONArray(paths)))
    }

    /**
     * Commit, push and open-PR run as one server-side stacked action rather than three calls the
     * phone sequences itself; a dropped connection between steps would otherwise leave the branch
     * committed but unpushed with nothing to report it.
     */
    suspend fun runGitAction(
        cwd: String,
        action: GitAction,
        commitMessage: String? = null,
        filePaths: List<String>? = null,
    ): GitActionOutcome {
        val payload = JSONObject()
            .put("actionId", newId())
            .put("cwd", cwd)
            .put("action", action.wire)
        commitMessage?.takeIf { it.isNotBlank() }?.let { payload.put("commitMessage", it) }
        filePaths?.takeIf { it.isNotEmpty() }?.let { payload.put("filePaths", JSONArray(it)) }
        return GitActionOutcome.fromJson(rpc("git.runStackedAction", payload) ?: JSONObject())
    }

    suspend fun listModels(provider: String = Provider.CODEX.kind): List<ModelOption> {
        val response = rpc(
            "provider.listModels",
            JSONObject().put("provider", provider),
        ) ?: return emptyList()
        return response.arrayOrEmpty("models").objects().mapNotNull { model ->
            val slug = model.stringOrNull("slug") ?: return@mapNotNull null
            ModelOption(
                slug = slug,
                name = model.stringOrNull("name") ?: slug,
                description = model.stringOrNull("description"),
                provider = provider,
            )
        }
    }

    /**
     * Model discovery per provider is independent and slow-ish, so the providers are queried
     * concurrently and a provider that is not installed simply contributes nothing rather than
     * failing the whole load.
     */
    suspend fun listAllModels(): List<ModelOption> = withContext(Dispatchers.IO) {
        Provider.entries
            .map { provider -> async { runCatching { listModels(provider.kind) }.getOrDefault(emptyList()) } }
            .awaitAll()
            .flatten()
    }

    fun disconnect(clearCredentials: Boolean = false) {
        closeSocket()
        if (clearCredentials) store.clearAll()
        sessionToken = null
        baseUrl = null
        setConnectionState(ConnectionState.DISCONNECTED)
    }

    private suspend fun openAuthenticatedSocket(serverUrl: HttpUrl, bearerToken: String) {
        val wsToken = postJson(
            serverUrl,
            "/api/auth/ws-token",
            JSONObject(),
            bearerToken,
        ).stringOrNull("token") ?: throw AuthRequiredException("The Synara session expired. Pair again.")

        val compatibility = negotiate(serverUrl)
        val httpFeatureUrl = serverUrl.newBuilder()
            .encodedPath("/ws")
            .addQueryParameter("wsToken", wsToken)
            .addQueryParameter("x-synara-client-build", "android-0.1.0")
            .addQueryParameter("x-synara-protocol-epoch", compatibility.optInt("protocolEpoch", 1).toString())
            .addQueryParameter("x-synara-protocol-revision", compatibility.optInt("negotiatedRevision", 1).toString())
            .addQueryParameter("x-synara-server-instance", compatibility.stringOrNull("serverInstanceId") ?: "")
            .build()
        val wsUrl = httpFeatureUrl.toString().replaceFirst(
            if (serverUrl.isHttps) "https://" else "http://",
            if (serverUrl.isHttps) "wss://" else "ws://",
        )

        val opened = CompletableDeferred<Unit>()
        // OkHttp accepts ws/wss when given the URL string and internally converts it to
        // http/https for the upgrade request.
        val request = Request.Builder().url(wsUrl).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                events.tryEmit(RepositoryEvent.ConnectionChanged(ConnectionState.CONNECTED))
                opened.complete(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleFrame(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!opened.isCompleted) opened.completeExceptionally(IOException(reason.ifBlank { "Connection closed." }))
                events.tryEmit(RepositoryEvent.ConnectionChanged(ConnectionState.DISCONNECTED))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!opened.isCompleted) opened.completeExceptionally(t)
                events.tryEmit(RepositoryEvent.ConnectionChanged(ConnectionState.DISCONNECTED))
                events.tryEmit(RepositoryEvent.Error(t.message ?: "Connection lost."))
                failPending(t)
            }
        })
        try {
            withTimeout(15_000) { opened.await() }
            refreshWorkspace()
            subscribeShell()
        } catch (error: Throwable) {
            socket?.cancel()
            socket = null
            throw error
        }
    }

    private suspend fun negotiate(serverUrl: HttpUrl): JSONObject {
        val builder = serverUrl.newBuilder()
            .encodedPath("/ws/negotiate")
            .addQueryParameter("x-synara-client-build", "android-0.1.0")
            .addQueryParameter("x-synara-protocol-epoch", "1")
            .addQueryParameter("x-synara-protocol-min-revision", "1")
            .addQueryParameter("x-synara-protocol-max-revision", "1")
        listOf(
            "orchestration.cursor-safe-streams",
            "orchestration.thread-detail-snapshot",
            "rpc.typed-errors",
        ).forEach { builder.addQueryParameter("x-synara-required-capability", it) }
        return executeRequest(Request.Builder().url(builder.build()).get().build()).body
    }

    private suspend fun postJson(
        serverUrl: HttpUrl,
        path: String,
        payload: JSONObject,
        bearerToken: String? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val url = serverUrl.newBuilder().encodedPath(path).build()
        val requestBuilder = Request.Builder()
            .url(url)
            .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
            .header("Content-Type", "application/json")
        bearerToken?.let { requestBuilder.header("Authorization", "Bearer $it") }
        executeRequest(requestBuilder.build()).body
    }

    private suspend fun executeRequest(request: Request): HttpResult = withContext(Dispatchers.IO) {
        http.newCall(request).execute().use { response ->
            val bodyText = response.body?.string().orEmpty()
            val body = runCatching { JSONObject(bodyText) }.getOrElse { JSONObject() }
            if (response.code == 401 || response.code == 403) {
                throw AuthRequiredException(body.stringOrNull("error") ?: "Synara rejected this session.")
            }
            if (!response.isSuccessful) {
                val detail = body.stringOrNull("message") ?: body.stringOrNull("error")
                throw IOException(detail ?: "Synara returned HTTP ${response.code}.")
            }
            HttpResult(response.code, body)
        }
    }

    /**
     * Every orchestration mutation is a command with the same envelope — `type` plus a fresh
     * `commandId` — so the envelope is built once here and callers only supply their own fields.
     */
    private suspend fun dispatch(type: String, build: JSONObject.() -> Unit): JSONObject? {
        val command = JSONObject()
            .put("type", type)
            .put("commandId", newId())
            .apply(build)
        return rpc("orchestration.dispatchCommand", command)
    }

    private suspend fun rpc(tag: String, payload: JSONObject): JSONObject? {
        val id = requestIds.getAndIncrement().toString()
        val deferred = CompletableDeferred<JSONObject?>()
        pending[id] = deferred
        if (!sendFrame(
            JSONObject()
                .put("_tag", "Request")
                .put("id", id)
                .put("tag", tag)
                .put("payload", payload)
                .put("headers", JSONArray()),
        )) {
            pending.remove(id)
            throw IOException("The Synara connection is not ready.")
        }
        return try {
            withTimeout(60_000) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    private suspend fun streamRpc(
        tag: String,
        payload: JSONObject,
        onValue: (JSONObject) -> Unit,
    ): String {
        val id = requestIds.getAndIncrement().toString()
        streams[id] = onValue
        if (!sendFrame(
            JSONObject()
                .put("_tag", "Request")
                .put("id", id)
                .put("tag", tag)
                .put("payload", payload)
                .put("headers", JSONArray()),
        )) {
            streams.remove(id)
            throw IOException("The Synara connection is not ready.")
        }
        return id
    }

    private fun handleFrame(text: String) {
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (frame.stringOrNull("_tag")) {
            "Ping" -> sendFrame(JSONObject().put("_tag", "Pong"))
            "Chunk" -> {
                val requestId = frame.stringOrNull("requestId") ?: return
                val handler = streams[requestId]
                frame.optJSONArray("values")?.objects()?.forEach { value -> handler?.invoke(value) }
                sendFrame(JSONObject().put("_tag", "Ack").put("requestId", requestId))
            }
            "Exit" -> {
                val requestId = frame.stringOrNull("requestId") ?: return
                val exit = frame.objectOrNull("exit") ?: return
                if (exit.stringOrNull("_tag") == "Success") {
                    val value = exit.opt("value")
                    val response = when (value) {
                        is JSONObject -> value
                        JSONObject.NULL, null -> null
                        else -> JSONObject().put("value", value)
                    }
                    pending[requestId]?.complete(response)
                    streams.remove(requestId)?.let { streamCompletions.remove(requestId)?.invoke() }
                } else {
                    val error = rpcFailureMessage(exit)
                    pending[requestId]?.completeExceptionally(IOException(error))
                    streams.remove(requestId)
                    streamCompletions.remove(requestId)?.invoke()
                }
            }
            "Defect" -> failPending(IOException(frame.optString("defect", "Synara RPC failed.")))
        }
    }

    private fun rpcFailureMessage(exit: JSONObject): String {
        fun findMessage(value: Any?): String? = when (value) {
            is JSONObject -> {
                value.stringOrNull("message")
                    ?: value.stringOrNull("error")
                    ?: findMessage(value.opt("error"))
                    ?: findMessage(value.opt("cause"))
                    ?: findMessage(value.opt("data"))
            }
            is JSONArray -> (0 until value.length()).asSequence()
                .mapNotNull { index -> findMessage(value.opt(index)) }
                .firstOrNull()
            else -> null
        }
        return findMessage(exit.opt("cause"))
            ?: exit.stringOrNull("message")
            ?: "Synara rejected the request."
    }

    private fun sendFrame(frame: JSONObject): Boolean {
        val currentSocket = socket ?: return false
        if (!currentSocket.send(frame.toString())) {
            events.tryEmit(RepositoryEvent.Error("The WebSocket is not ready."))
            return false
        }
        return true
    }

    private fun closeSocket() {
        socket?.close(1000, "client closing")
        socket = null
        failPending(IOException("Connection closed."))
        streams.clear()
        streamCompletions.clear()
    }

    private fun failPending(error: Throwable) {
        pending.values.forEach { deferred -> deferred.completeExceptionally(error) }
        pending.clear()
    }

    private fun setConnectionState(state: ConnectionState) {
        events.tryEmit(RepositoryEvent.ConnectionChanged(state))
    }

    private fun newId(): String = java.util.UUID.randomUUID().toString()

    private data class HttpResult(val code: Int, val body: JSONObject)

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun normalizeBaseUrl(input: String): HttpUrl {
            val candidate = input.trim().let { value ->
                if (value.startsWith("http://") || value.startsWith("https://")) value else "http://$value"
            }.trimEnd('/')
            return candidate.toHttpUrlOrNull()
                ?: throw IllegalArgumentException("Enter a valid server URL, for example http://192.168.1.5:3773")
        }

        fun extractPairingCredential(input: String): String {
            val value = input.trim()
            if (value.isBlank()) return ""
            return runCatching {
                val url = value.toHttpUrlOrNull() ?: return@runCatching value
                val fragment = url.fragment
                val fromFragment = fragment
                    ?.split('&')
                    ?.mapNotNull { part -> part.split('=', limit = 2).takeIf { it.size == 2 } }
                    ?.firstOrNull { it[0] == "token" }
                    ?.get(1)
                fromFragment ?: url.queryParameter("token") ?: value
            }.getOrDefault(value)
        }
    }
}
