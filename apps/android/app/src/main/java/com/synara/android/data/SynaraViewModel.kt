package com.synara.android.data

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

enum class AppScreen {
    WORKSPACE,
    CHAT,
    SETTINGS,
    DIFF,
    SOURCE_CONTROL,
    AUTOMATIONS,
    TERMINAL,
    KANBAN,
    CATALOGUE,
}

data class CatalogueState(
    val catalogue: ProviderCatalogue? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    val providerLabel: String? = null,
    /** Thread the loaded catalogue belongs to; it is per-checkout, so it cannot be shared. */
    val loadedForThreadId: String? = null,
)

data class TerminalState(
    val threadId: String? = null,
    val cwd: String? = null,
    val snapshot: TerminalSnapshot? = null,
    /**
     * Bumped on every output event. The buffer itself is mutable and identity-stable, so Compose
     * needs a changing value to know a redraw is due; re-parsing a whole scrollback into an
     * immutable list on every PTY flush would drop frames on a busy build.
     */
    val revision: Int = 0,
    val isConnecting: Boolean = false,
    val error: String? = null,
) {
    val isRunning: Boolean get() = snapshot?.isRunning == true
}

data class AutomationsState(
    val list: AutomationList? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    /** Automation whose detail sheet is open. */
    val selectedId: String? = null,
    val busyId: String? = null,
    val createOpen: Boolean = false,
)

data class SourceControlState(
    val cwd: String? = null,
    val status: GitStatus? = null,
    val branches: GitBranches? = null,
    val isLoading: Boolean = false,
    /** Set while a mutating action runs, so the UI can disable the whole action set at once. */
    val busyLabel: String? = null,
    val error: String? = null,
    val notice: String? = null,
    val commitMessage: String = "",
    val branchPickerOpen: Boolean = false,
)

/**
 * Which set of changes the diff screen is showing. The desktop offers the same three through its
 * DiffPanel toolbar; keeping them as one enum means the screen has a single source of truth for
 * both the request it makes and the label it shows.
 */
enum class DiffScope(val label: String) {
    THREAD("All thread changes"),
    TURN("Latest turn"),
    WORKING_TREE("Working tree"),
}

data class DiffState(
    val scope: DiffScope = DiffScope.THREAD,
    val parsed: ParsedDiff? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    /** Paths currently expanded in the file list. */
    val expanded: Set<String> = emptySet(),
)

data class SynaraUiState(
    val screen: AppScreen = AppScreen.WORKSPACE,
    val connection: ConnectionState = ConnectionState.DISCONNECTED,
    val serverUrl: String = "",
    val hasStoredSession: Boolean = false,
    val projects: List<ProjectItem> = emptyList(),
    val threads: List<ThreadItem> = emptyList(),
    val selectedProjectId: String? = null,
    val selectedThreadId: String? = null,
    val detail: ThreadDetail? = null,
        val models: List<ModelOption> = listOf(ModelOption("gpt-5.6-sol", "GPT-5.6 Sol", null)),
    val isLoading: Boolean = false,
    val isSending: Boolean = false,
    val isRefreshing: Boolean = false,
    val setupError: String? = null,
    val error: String? = null,
    val createProjectOpen: Boolean = false,
    val createThreadOpen: Boolean = false,
    /** Thread whose action sheet is open, if any. */
    val threadActionsFor: String? = null,
    /** Project whose action sheet is open, if any. */
    val projectActionsFor: String? = null,
    val showArchived: Boolean = false,
    val diff: DiffState = DiffState(),
    val git: SourceControlState = SourceControlState(),
    val automations: AutomationsState = AutomationsState(),
    val terminal: TerminalState = TerminalState(),
    val catalogue: CatalogueState = CatalogueState(),
) {
    val isConnected: Boolean
        get() = connection == ConnectionState.CONNECTED

    val selectedThread: ThreadItem?
        get() = selectedThreadId?.let { id -> threads.firstOrNull { it.id == id } }
            ?: detail?.thread
}

class SynaraViewModel(private val repository: SynaraRepository) : ViewModel() {
    private val _ui = MutableStateFlow(
        SynaraUiState(
            serverUrl = repository.storedSession()?.baseUrl ?: "",
            hasStoredSession = repository.storedSession() != null,
        ),
    )
    val ui: StateFlow<SynaraUiState> = _ui.asStateFlow()

    private var activeThreadStream: String? = null
    private var activeShellStream: String? = null

    init {
        viewModelScope.launch {
            repository.events().collect(::onRepositoryEvent)
        }
        if (repository.storedSession() != null) {
            reconnectStored()
        }
    }

    fun connect(serverUrl: String, pairingInput: String) {
        update { it.copy(serverUrl = serverUrl.trim(), setupError = null, isLoading = true) }
        viewModelScope.launch {
            runCatching {
                repository.connectWithPairing(serverUrl, pairingInput)
                loadModels()
            }.onSuccess {
                update { it.copy(isLoading = false, screen = AppScreen.WORKSPACE, hasStoredSession = true) }
            }.onFailure { error ->
                repository.disconnect(clearCredentials = error is AuthRequiredException)
                update {
                    it.copy(
                        isLoading = false,
                        hasStoredSession = error !is AuthRequiredException && repository.storedSession() != null,
                        setupError = readableError(error),
                    )
                }
            }
        }
    }

    fun reconnectStored() {
        if (_ui.value.isLoading || _ui.value.connection == ConnectionState.CONNECTING) return
        update { it.copy(connection = ConnectionState.CONNECTING, isLoading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.reconnectStored()
                loadModels()
            }.onSuccess {
                update { it.copy(isLoading = false, screen = AppScreen.WORKSPACE) }
            }.onFailure { error ->
                val needsPairing = error is AuthRequiredException
                if (needsPairing) repository.disconnect(clearCredentials = true)
                update {
                    it.copy(
                        isLoading = false,
                        hasStoredSession = !needsPairing && repository.storedSession() != null,
                        setupError = if (needsPairing) readableError(error) else null,
                        error = if (needsPairing) null else readableError(error),
                    )
                }
            }
        }
    }

    fun refreshOrReconnect() {
        if (_ui.value.connection == ConnectionState.CONNECTED) refresh()
        else if (_ui.value.hasStoredSession) reconnectStored()
    }

    fun openWorkspace() {
        update { it.copy(screen = AppScreen.WORKSPACE, selectedThreadId = null, detail = null) }
        stopActiveThreadStream()
    }

    fun openSettings() {
        update { it.copy(screen = AppScreen.SETTINGS) }
    }

    fun selectProject(projectId: String?) {
        update { it.copy(selectedProjectId = projectId, screen = AppScreen.WORKSPACE) }
    }

    fun selectThread(threadId: String) {
        if (_ui.value.selectedThreadId == threadId && _ui.value.detail != null) {
            update { it.copy(screen = AppScreen.CHAT) }
            return
        }
        update {
            it.copy(
                screen = AppScreen.CHAT,
                selectedThreadId = threadId,
                detail = null,
                isLoading = true,
                error = null,
            )
        }
        stopActiveThreadStream()
        viewModelScope.launch {
            runCatching {
                repository.loadThread(threadId)
                repository.subscribeThread(threadId)
            }.onSuccess { streamId ->
                activeThreadStream = streamId
                update { it.copy(isLoading = false) }
                // Warm the catalogue so the composer can offer slash commands and skills the
                // moment they are typed, rather than showing an empty list while it fetches.
                prefetchCatalogue(threadId)
            }.onFailure { error ->
                update { it.copy(isLoading = false, error = readableError(error)) }
            }
        }
    }

    fun refresh() {
        if (_ui.value.connection != ConnectionState.CONNECTED) return
        update { it.copy(isRefreshing = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.refreshWorkspace() }
                .onFailure { error -> update { it.copy(error = readableError(error)) } }
            update { it.copy(isRefreshing = false) }
        }
    }

    fun sendMessage(text: String) {
        val cleanText = text.trim()
        val detail = _ui.value.detail ?: return
        val thread = detail.thread
        if (cleanText.isBlank() || _ui.value.isSending) return
        val messageId = UUID.randomUUID().toString()
        val optimistic = MessageItem(
            id = messageId,
            role = "user",
            text = cleanText,
            streaming = false,
            createdAt = nowIso(),
            turnId = null,
        )
        update {
            it.copy(
                isSending = true,
                error = null,
                detail = detail.copy(messages = detail.messages + optimistic),
            )
        }
        viewModelScope.launch {
            runCatching { repository.sendMessage(thread, cleanText, messageId) }
                .onSuccess { update { it.copy(isSending = false) } }
                .onFailure { error ->
                    update { it.copy(isSending = false, error = readableError(error)) }
                    repository.loadThread(thread.id)
                }
        }
    }

    fun interruptThread() {
        val thread = _ui.value.detail?.thread ?: return
        viewModelScope.launch {
            runCatching { repository.interruptThread(thread) }
                .onFailure { error -> update { it.copy(error = readableError(error)) } }
        }
    }

    fun respondToApproval(interaction: PendingInteraction, decision: String) {
        val threadId = _ui.value.selectedThreadId ?: return
        viewModelScope.launch {
            runCatching { repository.respondToApproval(threadId, interaction, decision) }
                .onFailure { error -> update { it.copy(error = readableError(error)) } }
        }
    }

    fun respondToUserInput(interaction: PendingInteraction, answers: JSONObject) {
        val threadId = _ui.value.detail?.thread?.id ?: _ui.value.selectedThreadId ?: return
        markInteractionStatus(interaction, "responding")
        viewModelScope.launch {
            runCatching { repository.respondToUserInput(threadId, interaction, answers) }
                .onFailure {
                    markInteractionStatus(interaction, "retryable")
                    update { state -> state.copy(error = readableError(it)) }
                }
        }
    }

    fun openCreateProject() {
        update { it.copy(createProjectOpen = true) }
    }

    fun closeCreateProject() {
        update { it.copy(createProjectOpen = false) }
    }

    fun createProject(title: String, root: String, model: ModelOption) {
        if (title.isBlank() || root.isBlank()) return
        update { it.copy(createProjectOpen = false, isLoading = true, error = null) }
        viewModelScope.launch {
            runCatching { repository.createProject(title.trim(), root.trim(), model) }
                .onSuccess {
                    repository.refreshWorkspace()
                    update { it.copy(isLoading = false) }
                }
                .onFailure { error -> update { it.copy(isLoading = false, error = readableError(error)) } }
        }
    }

    fun openCreateThread(projectId: String? = _ui.value.selectedProjectId) {
        if (projectId != null) update { it.copy(selectedProjectId = projectId) }
        update { it.copy(createThreadOpen = true) }
    }

    fun closeCreateThread() {
        update { it.copy(createThreadOpen = false) }
    }

    fun createThread(
        title: String,
        model: ModelOption,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = InteractionMode.DEFAULT,
    ) {
        val project = _ui.value.selectedProjectId?.let { id -> _ui.value.projects.firstOrNull { it.id == id } }
            ?: _ui.value.projects.firstOrNull()
            ?: return
        if (title.isBlank()) return
        update { it.copy(createThreadOpen = false, isLoading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repository.createThread(
                    project,
                    title.trim(),
                    model,
                    runtimeMode.wire,
                    interactionMode.wire,
                )
            }
                .onSuccess { threadId ->
                    repository.refreshWorkspace()
                    update { it.copy(isLoading = false) }
                    selectThread(threadId)
                }
                .onFailure { error -> update { it.copy(isLoading = false, error = readableError(error)) } }
        }
    }

    // ── Thread management ────────────────────────────────────────────────────────────────────

    /**
     * Mutations follow one shape: run the command, surface a failure as a dismissible error, and
     * let the authoritative shell snapshot that follows correct local state. Nothing here writes
     * an optimistic result the server might contradict, which is what keeps the list honest when
     * a command is rejected.
     */
    private fun mutate(onFailure: String? = null, block: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { block() }
                .onFailure { error ->
                    update { it.copy(error = onFailure ?: readableError(error)) }
                }
        }
    }

    fun archiveThread(threadId: String) = mutate {
        repository.archiveThread(threadId)
        // Leaving the archived thread open would strand the user on a screen the workspace list
        // no longer offers a way back to.
        if (_ui.value.selectedThreadId == threadId) openWorkspace()
        repository.refreshWorkspace()
    }

    fun unarchiveThread(threadId: String) = mutate {
        repository.unarchiveThread(threadId)
        repository.refreshWorkspace()
    }

    fun deleteThread(threadId: String) = mutate {
        repository.deleteThread(threadId)
        if (_ui.value.selectedThreadId == threadId) openWorkspace()
        repository.refreshWorkspace()
    }

    fun renameThread(threadId: String, title: String) {
        val clean = title.trim()
        if (clean.isEmpty()) return
        mutate {
            repository.updateThreadMeta(threadId, title = clean)
            repository.refreshWorkspace()
        }
    }

    fun setThreadPinned(threadId: String, pinned: Boolean) = mutate {
        repository.updateThreadMeta(threadId, isPinned = pinned)
        repository.refreshWorkspace()
    }

    fun setThreadModel(threadId: String, model: ModelOption) = mutate {
        repository.updateThreadMeta(threadId, model = model)
        repository.loadThread(threadId)
    }

    fun setRuntimeMode(threadId: String, runtimeMode: RuntimeMode) = mutate {
        repository.setRuntimeMode(threadId, runtimeMode.wire)
        repository.loadThread(threadId)
    }

    fun setInteractionMode(threadId: String, interactionMode: InteractionMode) = mutate {
        repository.setInteractionMode(threadId, interactionMode.wire)
        repository.loadThread(threadId)
    }

    // ── Project management ───────────────────────────────────────────────────────────────────

    fun renameProject(projectId: String, title: String) {
        val clean = title.trim()
        if (clean.isEmpty()) return
        mutate {
            repository.updateProjectMeta(projectId, title = clean)
            repository.refreshWorkspace()
        }
    }

    fun setProjectPinned(projectId: String, pinned: Boolean) = mutate {
        repository.updateProjectMeta(projectId, isPinned = pinned)
        repository.refreshWorkspace()
    }

    fun deleteProject(projectId: String) = mutate {
        repository.deleteProject(projectId)
        update { state ->
            state.copy(selectedProjectId = state.selectedProjectId?.takeIf { it != projectId })
        }
        repository.refreshWorkspace()
    }

    // ── Diffs ────────────────────────────────────────────────────────────────────────────────

    fun openDiff(scope: DiffScope = DiffScope.THREAD) {
        update { it.copy(screen = AppScreen.DIFF, diff = DiffState(scope = scope, isLoading = true)) }
        loadDiff(scope)
    }

    fun setDiffScope(scope: DiffScope) {
        if (_ui.value.diff.scope == scope && _ui.value.diff.parsed != null) return
        update { it.copy(diff = it.diff.copy(scope = scope, isLoading = true, error = null)) }
        loadDiff(scope)
    }

    fun reloadDiff() = loadDiff(_ui.value.diff.scope)

    fun toggleDiffFile(path: String) {
        update { state ->
            val expanded = state.diff.expanded
            state.copy(
                diff = state.diff.copy(
                    expanded = if (path in expanded) expanded - path else expanded + path,
                ),
            )
        }
    }

    fun closeDiff() {
        update {
            it.copy(
                screen = if (it.selectedThreadId != null) AppScreen.CHAT else AppScreen.WORKSPACE,
                diff = DiffState(),
            )
        }
    }

    private fun loadDiff(scope: DiffScope) {
        val detail = _ui.value.detail
        val thread = detail?.thread ?: _ui.value.selectedThread
        update { it.copy(diff = it.diff.copy(isLoading = true, error = null)) }
        viewModelScope.launch {
            runCatching {
                when (scope) {
                    DiffScope.THREAD -> {
                        val to = detail?.latestTurnCount
                            ?: error("This thread has no completed turns to compare yet.")
                        repository.getFullThreadDiff(thread!!.id, to)
                    }

                    DiffScope.TURN -> {
                        val to = detail?.latestTurnCount
                            ?: error("This thread has no completed turns to compare yet.")
                        // A turn's own change set is the span since the previous checkpoint; the
                        // first turn compares against an empty tree at count 0.
                        val from = detail.checkpoints
                            .map { it.turnCount }
                            .filter { it < to }
                            .maxOrNull()
                            ?: 0
                        repository.getTurnDiff(thread!!.id, from, to)
                    }

                    DiffScope.WORKING_TREE -> {
                        val cwd = thread?.gitCwd
                            ?: error("This thread has no checkout on disk to diff.")
                        repository.readWorkingTreeDiff(cwd)
                    }
                }
            }.onSuccess { patch ->
                val parsed = parseUnifiedDiff(patch)
                update {
                    it.copy(
                        diff = it.diff.copy(
                            scope = scope,
                            parsed = parsed,
                            isLoading = false,
                            error = null,
                            // A single changed file is opened for you; more than that and the file
                            // list is the more useful first view.
                            expanded = if (parsed.files.size == 1) setOf(parsed.files.first().path) else emptySet(),
                        ),
                    )
                }
            }.onFailure { error ->
                update {
                    it.copy(diff = it.diff.copy(isLoading = false, error = readableError(error)))
                }
            }
        }
    }

    // ── Board and catalogue ──────────────────────────────────────────────────────────────────

    fun openKanban() {
        update { it.copy(screen = AppScreen.KANBAN) }
    }

    fun closeKanban() {
        update { it.copy(screen = AppScreen.WORKSPACE) }
    }

    fun openCatalogue() {
        val thread = _ui.value.detail?.thread ?: _ui.value.selectedThread
        val cwd = thread?.gitCwd
        if (thread == null || cwd == null) {
            update { it.copy(error = "This thread has no working directory to read skills from.") }
            return
        }
        update {
            it.copy(
                screen = AppScreen.CATALOGUE,
                catalogue = it.catalogue.copy(
                    isLoading = it.catalogue.loadedForThreadId != thread.id,
                    providerLabel = thread.providerLabel,
                ),
            )
        }
        viewModelScope.launch {
            runCatching { repository.loadCatalogue(thread.provider, cwd, thread.id) }
                .onSuccess { catalogue ->
                    update {
                        it.copy(
                            catalogue = it.catalogue.copy(
                                catalogue = catalogue,
                                isLoading = false,
                                loadedForThreadId = thread.id,
                            ),
                        )
                    }
                }
                .onFailure { error ->
                    update {
                        it.copy(
                            catalogue = it.catalogue.copy(isLoading = false, error = readableError(error)),
                        )
                    }
                }
        }
    }

    private fun prefetchCatalogue(threadId: String) {
        if (_ui.value.catalogue.loadedForThreadId == threadId) return
        val thread = _ui.value.threads.firstOrNull { it.id == threadId } ?: _ui.value.detail?.thread
        val cwd = thread?.gitCwd ?: return
        viewModelScope.launch {
            runCatching { repository.loadCatalogue(thread.provider, cwd, threadId) }
                .onSuccess { catalogue ->
                    update {
                        it.copy(
                            catalogue = it.catalogue.copy(
                                catalogue = catalogue,
                                providerLabel = thread.providerLabel,
                                loadedForThreadId = threadId,
                            ),
                        )
                    }
                }
        }
    }

    fun closeCatalogue() {
        // The loaded catalogue is kept: it still backs the composer's suggestions after the
        // screen closes, and refetching it on every visit would stall typing.
        update {
            it.copy(
                screen = if (it.selectedThreadId != null) AppScreen.CHAT else AppScreen.WORKSPACE,
                catalogue = it.catalogue.copy(isLoading = false, error = null),
            )
        }
    }

    // ── Terminal ─────────────────────────────────────────────────────────────────────────────

    /**
     * The rendered scrollback. Held outside [SynaraUiState] because it is a mutable emulator that
     * output is streamed into; copying its contents into immutable state on every PTY flush would
     * cost more than drawing them.
     */
    val terminalBuffer = AnsiTerminalBuffer()

    private var terminalStream: String? = null

    fun openTerminal() {
        val thread = _ui.value.detail?.thread ?: _ui.value.selectedThread
        val cwd = thread?.gitCwd
        if (thread == null || cwd == null) {
            update { it.copy(error = "This thread has no working directory to open a shell in.") }
            return
        }
        terminalBuffer.clear()
        update {
            it.copy(
                screen = AppScreen.TERMINAL,
                terminal = TerminalState(threadId = thread.id, cwd = cwd, isConnecting = true),
            )
        }
        viewModelScope.launch {
            runCatching {
                // Subscribe before opening, so output produced between the two is not missed.
                if (terminalStream == null) {
                    terminalStream = repository.subscribeTerminalEvents(::onTerminalEvent)
                }
                repository.openTerminal(thread.id, cwd)
            }.onSuccess { snapshot ->
                if (snapshot.history.isNotEmpty()) terminalBuffer.append(snapshot.history)
                update {
                    it.copy(
                        terminal = it.terminal.copy(
                            snapshot = snapshot,
                            isConnecting = false,
                            revision = it.terminal.revision + 1,
                        ),
                    )
                }
            }.onFailure { error ->
                update {
                    it.copy(
                        terminal = it.terminal.copy(isConnecting = false, error = readableError(error)),
                    )
                }
            }
        }
    }

    fun closeTerminalScreen() {
        // The PTY deliberately keeps running: leaving the screen is not the same as ending a
        // session, and a build killed by backing out would be a nasty surprise.
        update {
            it.copy(
                screen = if (it.selectedThreadId != null) AppScreen.CHAT else AppScreen.WORKSPACE,
            )
        }
    }

    fun sendTerminalInput(text: String) {
        val threadId = _ui.value.terminal.threadId ?: return
        viewModelScope.launch {
            runCatching { repository.writeTerminal(threadId, text) }
                .onFailure { error ->
                    update { it.copy(terminal = it.terminal.copy(error = readableError(error))) }
                }
        }
    }

    fun sendTerminalKey(key: TerminalKey) = sendTerminalInput(key.sequence)

    fun resizeTerminal(cols: Int, rows: Int) {
        val threadId = _ui.value.terminal.threadId ?: return
        viewModelScope.launch { runCatching { repository.resizeTerminal(threadId, cols, rows) } }
    }

    fun clearTerminal() {
        val threadId = _ui.value.terminal.threadId ?: return
        terminalBuffer.clear()
        update { it.copy(terminal = it.terminal.copy(revision = it.terminal.revision + 1)) }
        viewModelScope.launch { runCatching { repository.clearTerminal(threadId) } }
    }

    fun restartTerminal() {
        val terminal = _ui.value.terminal
        val threadId = terminal.threadId ?: return
        val cwd = terminal.cwd ?: return
        terminalBuffer.clear()
        update { it.copy(terminal = it.terminal.copy(revision = it.terminal.revision + 1, error = null)) }
        viewModelScope.launch {
            runCatching { repository.restartTerminal(threadId, cwd) }
                .onFailure { error ->
                    update { it.copy(terminal = it.terminal.copy(error = readableError(error))) }
                }
        }
    }

    private fun onTerminalEvent(event: JSONObject) {
        val threadId = _ui.value.terminal.threadId ?: return
        // One subscription carries every session's events, so anything for another thread or a
        // second terminal in this one has to be ignored rather than rendered here.
        if (event.stringOrNull("threadId") != threadId) return
        if (event.stringOrNull("terminalId") != (_ui.value.terminal.snapshot?.terminalId ?: DEFAULT_TERMINAL_ID)) return

        when (event.stringOrNull("type")) {
            "output" -> terminalBuffer.append(event.stringOrNull("data").orEmpty())
            "cleared" -> terminalBuffer.clear()
            "started", "restarted" -> {
                terminalBuffer.clear()
                event.objectOrNull("snapshot")?.let { snapshotJson ->
                    val snapshot = TerminalSnapshot.fromJson(snapshotJson)
                    if (snapshot.history.isNotEmpty()) terminalBuffer.append(snapshot.history)
                    update { it.copy(terminal = it.terminal.copy(snapshot = snapshot)) }
                }
            }

            "exited" -> {
                val code = event.optIntOrNull("exitCode")
                terminalBuffer.append("\n[process exited${code?.let { " with code $it" } ?: ""}]\n")
                update {
                    it.copy(
                        terminal = it.terminal.copy(
                            snapshot = it.terminal.snapshot?.copy(status = "exited", exitCode = code),
                        ),
                    )
                }
            }

            "error" -> update {
                it.copy(terminal = it.terminal.copy(error = event.stringOrNull("message")))
            }

            else -> return
        }
        update { it.copy(terminal = it.terminal.copy(revision = it.terminal.revision + 1)) }
    }

    // ── Automations ──────────────────────────────────────────────────────────────────────────

    fun openAutomations() {
        update { it.copy(screen = AppScreen.AUTOMATIONS, automations = AutomationsState(isLoading = true)) }
        refreshAutomations()
    }

    fun closeAutomations() {
        update { it.copy(screen = AppScreen.WORKSPACE, automations = AutomationsState()) }
    }

    fun refreshAutomations() {
        update { it.copy(automations = it.automations.copy(isLoading = true, error = null)) }
        viewModelScope.launch {
            runCatching { repository.listAutomations(_ui.value.selectedProjectId) }
                .onSuccess { list ->
                    update { it.copy(automations = it.automations.copy(list = list, isLoading = false)) }
                }
                .onFailure { error ->
                    update {
                        it.copy(
                            automations = it.automations.copy(isLoading = false, error = readableError(error)),
                        )
                    }
                }
        }
    }

    fun selectAutomation(id: String?) {
        update { it.copy(automations = it.automations.copy(selectedId = id)) }
    }

    fun setAutomationCreateOpen(open: Boolean) {
        update { it.copy(automations = it.automations.copy(createOpen = open)) }
    }

    fun dismissAutomationNotice() {
        update { it.copy(automations = it.automations.copy(notice = null, error = null)) }
    }

    fun setAutomationEnabled(id: String, enabled: Boolean) = automationOperation(id) {
        repository.setAutomationEnabled(id, enabled)
        update {
            it.copy(automations = it.automations.copy(notice = if (enabled) "Enabled." else "Paused."))
        }
    }

    fun runAutomationNow(id: String) = automationOperation(id) {
        repository.runAutomationNow(id)
        update { it.copy(automations = it.automations.copy(notice = "Run queued.")) }
    }

    fun cancelAutomationRun(runId: String, automationId: String) = automationOperation(automationId) {
        repository.cancelAutomationRun(runId)
        update { it.copy(automations = it.automations.copy(notice = "Run cancelled.")) }
    }

    fun deleteAutomation(id: String) = automationOperation(id) {
        repository.deleteAutomation(id)
        update { it.copy(automations = it.automations.copy(selectedId = null, notice = "Deleted.")) }
    }

    fun resolveAutomationProposal(id: String, accept: Boolean) = automationOperation(id) {
        repository.resolveAutomationProposal(id, accept)
        update {
            it.copy(
                automations = it.automations.copy(
                    selectedId = null,
                    notice = if (accept) "Automation accepted." else "Proposal dismissed.",
                ),
            )
        }
    }

    fun markAutomationRunRead(runId: String, automationId: String) = automationOperation(automationId) {
        repository.markAutomationRunRead(runId, unread = false)
    }

    fun createAutomation(
        name: String,
        prompt: String,
        schedule: JSONObject,
        model: ModelOption,
        mode: AutomationMode,
        runtimeMode: RuntimeMode,
        maxIterations: Int?,
    ) {
        val projectId = _ui.value.selectedProjectId ?: _ui.value.projects.firstOrNull()?.id ?: return
        update { it.copy(automations = it.automations.copy(createOpen = false, busyId = "new")) }
        viewModelScope.launch {
            runCatching {
                repository.createAutomation(
                    projectId, name.trim(), prompt.trim(), schedule, model, mode, runtimeMode, maxIterations,
                )
            }
                .onSuccess {
                    update { it.copy(automations = it.automations.copy(notice = "Automation created.")) }
                }
                .onFailure { error ->
                    update { it.copy(automations = it.automations.copy(error = readableError(error))) }
                }
            update { it.copy(automations = it.automations.copy(busyId = null)) }
            refreshAutomations()
        }
    }

    /**
     * Automation mutations all re-read the list afterwards: enabling, running and deleting each
     * change fields the server owns (nextRunAt, iterationCount, run rows), and guessing at them
     * locally would show a schedule that does not match what will actually happen.
     */
    private fun automationOperation(id: String, block: suspend () -> Unit) {
        if (_ui.value.automations.busyId != null) return
        update { it.copy(automations = it.automations.copy(busyId = id, error = null, notice = null)) }
        viewModelScope.launch {
            runCatching { block() }
                .onFailure { error ->
                    update { it.copy(automations = it.automations.copy(error = readableError(error))) }
                }
            update { it.copy(automations = it.automations.copy(busyId = null)) }
            refreshAutomations()
        }
    }

    // ── Source control ───────────────────────────────────────────────────────────────────────

    fun openSourceControl() {
        val cwd = (_ui.value.detail?.thread ?: _ui.value.selectedThread)?.gitCwd
        if (cwd == null) {
            update { it.copy(error = "This thread has no checkout on disk.") }
            return
        }
        update {
            it.copy(
                screen = AppScreen.SOURCE_CONTROL,
                git = SourceControlState(cwd = cwd, isLoading = true),
            )
        }
        refreshSourceControl()
    }

    fun closeSourceControl() {
        update {
            it.copy(
                screen = if (it.selectedThreadId != null) AppScreen.CHAT else AppScreen.WORKSPACE,
                git = SourceControlState(),
            )
        }
    }

    fun refreshSourceControl() {
        val cwd = _ui.value.git.cwd ?: return
        update { it.copy(git = it.git.copy(isLoading = true, error = null)) }
        viewModelScope.launch {
            // Status and branches are independent reads; running them together halves the wait on
            // a repository large enough for `git status` to be slow.
            val status = async { runCatching { repository.gitStatus(cwd) } }
            val branches = async { runCatching { repository.listBranches(cwd) } }
            val statusResult = status.await()
            val branchResult = branches.await()
            update { state ->
                state.copy(
                    git = state.git.copy(
                        status = statusResult.getOrNull() ?: state.git.status,
                        branches = branchResult.getOrNull() ?: state.git.branches,
                        isLoading = false,
                        error = statusResult.exceptionOrNull()?.let(::readableError),
                    ),
                )
            }
        }
    }

    fun setCommitMessage(message: String) {
        update { it.copy(git = it.git.copy(commitMessage = message)) }
    }

    fun setBranchPickerOpen(open: Boolean) {
        update { it.copy(git = it.git.copy(branchPickerOpen = open)) }
    }

    fun dismissGitNotice() {
        update { it.copy(git = it.git.copy(notice = null, error = null)) }
    }

    fun runGitAction(action: GitAction) {
        val cwd = _ui.value.git.cwd ?: return
        val message = _ui.value.git.commitMessage.trim()
        if (action != GitAction.PUSH && message.isEmpty()) {
            update { it.copy(git = it.git.copy(error = "Write a commit message first.")) }
            return
        }
        runGitOperation(action.label) {
            val outcome = repository.runGitAction(cwd, action, message.ifEmpty { null })
            update { it.copy(git = it.git.copy(commitMessage = "", notice = outcome.summary())) }
        }
    }

    fun gitPull() = runGitOperation("Pull") {
        val cwd = _ui.value.git.cwd!!
        val status = repository.pull(cwd)
        val notice = if (status == "skipped_up_to_date") "Already up to date." else "Pulled."
        update { it.copy(git = it.git.copy(notice = notice)) }
    }

    fun checkoutBranch(branch: String, stashFirst: Boolean) = runGitOperation("Checkout") {
        val cwd = _ui.value.git.cwd!!
        if (stashFirst) repository.stashAndCheckout(cwd, branch) else repository.checkout(cwd, branch)
        update {
            it.copy(
                git = it.git.copy(
                    branchPickerOpen = false,
                    notice = if (stashFirst) "Stashed changes and switched to $branch." else "Switched to $branch.",
                ),
            )
        }
    }

    fun createBranch(name: String) {
        val clean = name.trim()
        if (clean.isEmpty()) return
        runGitOperation("Create branch") {
            repository.createBranch(_ui.value.git.cwd!!, clean)
            update { it.copy(git = it.git.copy(branchPickerOpen = false, notice = "Created $clean.")) }
        }
    }

    /**
     * Every mutating git call follows the same arc: mark the screen busy, run, then re-read status
     * so the branch, counts and file list reflect the result rather than what they were before it.
     */
    private fun runGitOperation(label: String, block: suspend () -> Unit) {
        if (_ui.value.git.busyLabel != null) return
        update { it.copy(git = it.git.copy(busyLabel = label, error = null, notice = null)) }
        viewModelScope.launch {
            runCatching { block() }
                .onFailure { error ->
                    update { it.copy(git = it.git.copy(error = readableError(error))) }
                }
            update { it.copy(git = it.git.copy(busyLabel = null)) }
            refreshSourceControl()
        }
    }

    // ── Sheets ───────────────────────────────────────────────────────────────────────────────

    fun openThreadActions(threadId: String) {
        update { it.copy(threadActionsFor = threadId) }
    }

    fun closeThreadActions() {
        update { it.copy(threadActionsFor = null) }
    }

    fun openProjectActions(projectId: String) {
        update { it.copy(projectActionsFor = projectId) }
    }

    fun closeProjectActions() {
        update { it.copy(projectActionsFor = null) }
    }

    fun setShowArchived(show: Boolean) {
        update { it.copy(showArchived = show) }
    }

    fun dismissError() {
        update { it.copy(error = null) }
    }

    fun disconnect() {
        stopActiveThreadStream()
        activeShellStream?.let(repository::stopStream)
        activeShellStream = null
        // The terminal subscription outlives individual screens, so it is torn down with the
        // connection rather than when the terminal view is left.
        terminalStream?.let(repository::stopStream)
        terminalStream = null
        terminalBuffer.clear()
        repository.disconnect(clearCredentials = true)
        update {
            SynaraUiState(
                serverUrl = it.serverUrl,
                models = it.models,
                setupError = null,
            )
        }
    }

    override fun onCleared() {
        stopActiveThreadStream()
        terminalStream?.let(repository::stopStream)
        activeShellStream?.let(repository::stopStream)
        repository.disconnect()
        super.onCleared()
    }

    private suspend fun loadModels() {
        // Every provider is queried, not just Codex, so the model picker reflects what the
        // workspace can actually run.
        val discovered = runCatching { repository.listAllModels() }.getOrDefault(emptyList())
        if (discovered.isNotEmpty()) update { it.copy(models = discovered) }
    }

    private fun onRepositoryEvent(event: RepositoryEvent) {
        when (event) {
            is RepositoryEvent.ConnectionChanged -> update { state ->
                state.copy(
                    connection = event.state,
                    hasStoredSession = state.hasStoredSession || event.state == ConnectionState.CONNECTED,
                )
            }
            is RepositoryEvent.ShellChanged -> updateFromWorkspace(event.snapshot)
            is RepositoryEvent.ThreadSnapshot -> {
                if (event.detail.thread.id == _ui.value.selectedThreadId) {
                    updateFromDetail(event.detail)
                }
            }
            is RepositoryEvent.ThreadEvent -> {
                if (event.threadId == _ui.value.selectedThreadId) applyThreadEvent(event.event)
            }
            is RepositoryEvent.Error -> update { it.copy(error = event.message) }
        }
    }

    private fun updateFromWorkspace(snapshot: WorkspaceSnapshot) {
        update { state ->
            state.copy(
                projects = snapshot.projects,
                threads = snapshot.threads,
                selectedProjectId = state.selectedProjectId?.takeIf { id -> snapshot.projects.any { it.id == id } },
            )
        }
    }

    private fun updateFromDetail(detail: ThreadDetail) {
        update { state ->
            val threads = state.threads.map { if (it.id == detail.thread.id) detail.thread else it }
            state.copy(detail = detail, threads = threads)
        }
    }

    private fun applyThreadEvent(event: JSONObject) {
        val detail = _ui.value.detail ?: return
        val payload = event.objectOrNull("payload") ?: return
        val type = event.stringOrNull("type") ?: return
        val updated = when (type) {
            "thread.message-sent" -> applyMessageEvent(detail, payload)
            "thread.session-set" -> {
                val session = payload.objectOrNull("session")
                session?.let {
                    detail.copy(
                        thread = detail.thread.copy(
                            sessionStatus = it.stringOrNull("status"),
                            activeTurnId = it.stringOrNull("activeTurnId"),
                        ),
                    )
                } ?: detail
            }
            "thread.activity-appended" -> {
                payload.objectOrNull("activity")?.let { activity ->
                    applyActivityEvent(detail, ActivityItem.fromJson(activity))
                } ?: detail
            }
            "thread.approval-response-requested" -> updateInteractionStatus(detail, payload, "approval", "responding")
            "thread.user-input-response-requested" -> updateInteractionStatus(detail, payload, "userInput", "responding")
            "thread.proposed-plan-upserted" -> {
                detail.copy(proposedPlan = payload.objectOrNull("proposedPlan")?.stringOrNull("planMarkdown"))
            }
            "thread.turn-start-requested", "thread.turn-queued" -> detail.copy(
                thread = detail.thread.copy(
                    latestTurn = detail.thread.latestTurn?.copy(state = "running")
                        ?: LatestTurn("", "running"),
                ),
            )
            "thread.meta-updated" -> detail.copy(
                thread = detail.thread.copy(
                    title = payload.stringOrNull("title") ?: detail.thread.title,
                    runtimeMode = payload.stringOrNull("runtimeMode") ?: detail.thread.runtimeMode,
                ),
            )
            else -> detail
        }
        updateFromDetail(updated)
    }

    private fun applyActivityEvent(detail: ThreadDetail, activity: ActivityItem): ThreadDetail {
        val activities = if (activity.id.isNotBlank()) {
            detail.activities.filterNot { it.id == activity.id } + activity
        } else {
            detail.activities + activity
        }
        val payload = activity.payload
        val requestId = payload?.stringOrNull("requestId")
        val lifecycleGeneration = payload?.stringOrNull("lifecycleGeneration")
        val interactionKind = when (activity.kind) {
            "approval.requested", "approval.resolved", "provider.approval.respond.failed" -> "approval"
            "user-input.requested", "user-input.resolved", "provider.user-input.respond.failed" -> "userInput"
            else -> null
        }
        if (requestId == null || interactionKind == null) return detail.copy(activities = activities)

        val pending = detail.pendingInteractions.toMutableList()
        val matches = { interaction: PendingInteraction ->
            interaction.kind == interactionKind &&
                interaction.requestId == requestId &&
                (lifecycleGeneration == null || interaction.lifecycleGeneration == lifecycleGeneration)
        }
        when (activity.kind) {
            "approval.resolved", "user-input.resolved" -> pending.removeAll(matches)
            "provider.approval.respond.failed", "provider.user-input.respond.failed" -> {
                val status = if (payload.stringOrNull("settlementStatus") == "retryable") "retryable" else "uncertain"
                pending.replaceAll { interaction -> if (matches(interaction)) interaction.copy(status = status) else interaction }
            }
            else -> {
                val existingIndex = pending.indexOfFirst { it.kind == interactionKind && it.requestId == requestId }
                val existing = pending.getOrNull(existingIndex)
                val preservesSettlingState = existing != null &&
                    existing.lifecycleGeneration == lifecycleGeneration &&
                    existing.status in setOf("responding", "confirmed", "uncertain")
                if (!preservesSettlingState) {
                    val next = PendingInteraction(interactionKind, requestId, lifecycleGeneration, "pending", null)
                    if (existingIndex >= 0) pending[existingIndex] = next else pending += next
                }
            }
        }
        return detail.copy(activities = activities, pendingInteractions = pending)
    }

    private fun updateInteractionStatus(
        detail: ThreadDetail,
        payload: JSONObject,
        kind: String,
        status: String,
    ): ThreadDetail {
        val requestId = payload.stringOrNull("requestId") ?: return detail
        val lifecycleGeneration = payload.stringOrNull("lifecycleGeneration")
        return detail.copy(
            pendingInteractions = detail.pendingInteractions.map { interaction ->
                if (interaction.kind == kind && interaction.requestId == requestId &&
                    (lifecycleGeneration == null || interaction.lifecycleGeneration == lifecycleGeneration)
                ) {
                    interaction.copy(
                        status = status,
                        decision = payload.stringOrNull("decision") ?: interaction.decision,
                    )
                } else interaction
            },
        )
    }

    private fun markInteractionStatus(interaction: PendingInteraction, status: String) {
        update { state ->
            state.copy(
                detail = state.detail?.copy(
                    pendingInteractions = state.detail.pendingInteractions.map { current ->
                        if (current.kind == interaction.kind && current.requestId == interaction.requestId) {
                            current.copy(status = status)
                        } else current
                    },
                ),
            )
        }
    }

    private fun applyMessageEvent(detail: ThreadDetail, payload: JSONObject): ThreadDetail {
        val incoming = MessageItem.fromJson(payload)
        val existingIndex = detail.messages.indexOfFirst { it.id == incoming.id }
        val messages = detail.messages.toMutableList()
        if (existingIndex < 0) {
            messages += incoming
        } else {
            val existing = messages[existingIndex]
            messages[existingIndex] = if (incoming.streaming) {
                existing.copy(
                    text = existing.text + incoming.text,
                    streaming = true,
                    turnId = incoming.turnId ?: existing.turnId,
                    createdAt = incoming.createdAt.ifBlank { existing.createdAt },
                )
            } else {
                incoming.copy(text = incoming.text.ifBlank { existing.text })
            }
        }
        return detail.copy(messages = messages)
    }

    private fun stopActiveThreadStream() {
        activeThreadStream?.let(repository::stopStream)
        activeThreadStream = null
    }

    private fun update(transform: (SynaraUiState) -> SynaraUiState) {
        _ui.value = transform(_ui.value)
    }

    private fun readableError(error: Throwable): String = when (error) {
        is AuthRequiredException -> error.message ?: "Pair this phone with Synara again."
        is java.util.concurrent.TimeoutException -> "The server took too long to respond."
        else -> error.message?.takeIf { it.isNotBlank() } ?: "Something went wrong."
    }

    companion object {
        fun factory(repository: SynaraRepository): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    SynaraViewModel(repository) as T
            }
    }
}
