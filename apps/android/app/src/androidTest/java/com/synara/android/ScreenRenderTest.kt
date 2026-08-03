package com.synara.android

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.synara.android.data.AppScreen
import com.synara.android.data.CheckStatus
import com.synara.android.data.ConnectionState
import com.synara.android.data.DiffScope
import com.synara.android.data.DiffState
import com.synara.android.data.GitCheck
import com.synara.android.data.GitPullRequestInfo
import com.synara.android.data.GitReviewComment
import com.synara.android.data.LatestTurn
import com.synara.android.data.MessageItem
import com.synara.android.data.ModelOption
import com.synara.android.data.ProjectItem
import com.synara.android.data.PullRequestSnapshot
import com.synara.android.data.PullRequestState
import com.synara.android.data.SynaraRepository
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.ThreadDetail
import com.synara.android.data.ThreadItem
import com.synara.android.data.parseUnifiedDiff
import com.synara.android.ui.screens.DiffScreen
import com.synara.android.ui.screens.PullRequestScreen
import com.synara.android.ui.screens.WorkspaceScreen
import com.synara.android.ui.theme.SynaraTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Renders the screens that previously had only manual verification.
 *
 * These assert on what a user can actually read and reach — a thread's title, a file's counts, a
 * failing check — rather than on internal state. That is deliberate: the defects this suite exists
 * to catch are layout regressions that hide content, which a state assertion cannot see.
 *
 * The screens render from a `SynaraUiState` value, so the fixture is what is under test; the view
 * model only supplies callbacks. A real but unpaired one is used rather than making the production
 * parameter nullable purely to satisfy a test — it never connects, because there is no stored
 * session on a fresh instrumentation run.
 */
@RunWith(AndroidJUnit4::class)
class ScreenRenderTest {
    @get:Rule
    val compose = createComposeRule()

    private val viewModel by lazy {
        SynaraViewModel(SynaraRepository(InstrumentationRegistry.getInstrumentation().targetContext))
    }

    private fun thread(
        id: String = "t1",
        title: String = "Rewrite the transcript virtualiser",
        running: Boolean = false,
        approvals: Boolean = false,
    ) = ThreadItem(
        id = id,
        projectId = "p1",
        title = title,
        provider = "codex",
        model = "gpt-5.6-sol",
        runtimeMode = "approval-required",
        interactionMode = "default",
        latestTurn = LatestTurn("turn", if (running) "running" else "completed"),
        sessionStatus = if (running) "running" else "idle",
        activeTurnId = null,
        hasPendingApprovals = approvals,
        hasPendingUserInput = false,
        isPinned = false,
        archivedAt = null,
        updatedAt = "2026-01-01T00:00:00Z",
        workingDirectory = "/repo",
        worktreePath = null,
        branch = "main",
    )

    private fun baseState() = SynaraUiState(
        connection = ConnectionState.CONNECTED,
        serverUrl = "http://localhost:3773",
        hasStoredSession = true,
        projects = listOf(ProjectItem("p1", "synara", "/repo", false, null, 1)),
        threads = listOf(thread(), thread(id = "t2", title = "Fix the onboarding flow", approvals = true)),
        models = listOf(ModelOption("gpt-5.6-sol", "GPT-5.6 Sol", null)),
    )

    @Test
    fun workspaceListsThreadsAndSeparatesOnesNeedingAttention() {
        compose.setContent {
            SynaraTheme(darkTheme = true) { WorkspaceScreen(baseState(), viewModel) }
        }

        compose.onNodeWithText("Needs you").assertIsDisplayed()
        compose.onNodeWithText("Fix the onboarding flow").assertIsDisplayed()
        compose.onNodeWithText("Rewrite the transcript virtualiser").assertIsDisplayed()
        compose.onNodeWithText("Approval needed").assertIsDisplayed()
    }

    @Test
    fun workspaceShowsAnEmptyStateRatherThanABlankList() {
        compose.setContent {
            SynaraTheme(darkTheme = true) {
                WorkspaceScreen(baseState().copy(threads = emptyList()), viewModel)
            }
        }
        compose.onNodeWithText("No threads here yet").assertIsDisplayed()
    }

    private val patch = """
        diff --git a/src/app.ts b/src/app.ts
        --- a/src/app.ts
        +++ b/src/app.ts
        @@ -1,2 +1,2 @@
        -const a = 1;
        +const a = 2;
    """.trimIndent()

    private fun diffState(expanded: Set<String>): SynaraUiState {
        val t = thread()
        return baseState().copy(
            screen = AppScreen.DIFF,
            selectedThreadId = t.id,
            detail = ThreadDetail(t, emptyList(), emptyList(), emptyList(), null, null, 1),
            diff = DiffState(
                scope = DiffScope.THREAD,
                parsed = parseUnifiedDiff(patch),
                expanded = expanded,
            ),
        )
    }

    @Test
    fun diffScreenListsFilesWithTheirCounts() {
        compose.setContent {
            SynaraTheme(darkTheme = true) { DiffScreen(diffState(emptySet()), viewModel) }
        }

        compose.onNodeWithText("app.ts").assertIsDisplayed()
        compose.onNodeWithText("1 file").assertIsDisplayed()
        compose.onNodeWithText("src").assertIsDisplayed()
        // The count appears twice on purpose: once as the screen total, once on the only file.
        compose.onAllNodesWithText("+1").assertCountEquals(2)
    }

    @Test
    fun diffScreenHidesThePatchWhileTheFileIsCollapsed() {
        // Expansion is driven by the state the screen is given, so collapsed and expanded are two
        // fixtures rather than a click: clicking would only prove that a fixture this test holds
        // constant did not change.
        compose.setContent {
            SynaraTheme(darkTheme = true) { DiffScreen(diffState(emptySet()), viewModel) }
        }
        compose.onAllNodesWithText("const a = 2;").assertCountEquals(0)
    }

    @Test
    fun diffScreenRendersThePatchWhenTheFileIsExpanded() {
        compose.setContent {
            SynaraTheme(darkTheme = true) {
                DiffScreen(diffState(setOf("src/app.ts")), viewModel)
            }
        }
        compose.onAllNodesWithText("const a = 2;").onFirst().assertIsDisplayed()
    }

    @Test
    fun pullRequestScreenSummarisesFailingChecks() {
        val pr = GitPullRequestInfo(
            number = 512,
            title = "Key transcript rows by message id",
            url = "https://example.test/pr/512",
            baseBranch = "main",
            headBranch = "agent/keys",
            state = "open",
            isDraft = false,
            mergeability = "mergeable",
            additions = 8,
            deletions = 4,
            changedFiles = 3,
        )
        compose.setContent {
            SynaraTheme(darkTheme = true) {
                PullRequestScreen(
                    baseState().copy(
                        screen = AppScreen.PULL_REQUEST,
                        pullRequest = PullRequestState(
                            snapshot = PullRequestSnapshot(
                                pullRequest = pr,
                                checks = listOf(
                                    GitCheck("build", CheckStatus.SUCCESS, null),
                                    GitCheck("test", CheckStatus.FAILURE, null),
                                ),
                                comments = listOf(
                                    GitReviewComment("c1", "dana", "Please hoist this.", null, null, null),
                                ),
                                commentsTruncated = false,
                                commentsError = null,
                            ),
                        ),
                    ),
                    viewModel,
                )
            }
        }

        compose.onNodeWithText("Checks · 1 failing").assertIsDisplayed()
        compose.onNodeWithText("test").assertIsDisplayed()
        compose.onNodeWithText("Failed").assertIsDisplayed()
        compose.onNodeWithText("dana").assertIsDisplayed()
    }
}
