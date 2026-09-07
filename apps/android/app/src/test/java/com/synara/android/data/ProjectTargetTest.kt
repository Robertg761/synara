package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProjectTargetTest {
    private fun project(id: String, kind: ProjectKind) = ProjectItem(
        id = id,
        kind = kind,
        title = id,
        workspaceRoot = "/home/robert/$id",
        isPinned = false,
        spaceId = null,
    )

    /** The order the server actually returns on a workspace that has real projects. */
    private val workspace = listOf(
        project("Studio", ProjectKind.STUDIO),
        project("Home", ProjectKind.CHAT),
        project("synara", ProjectKind.PROJECT),
        project("Slide", ProjectKind.PROJECT),
    )

    @Test
    fun prefersARealProjectOverTheServersOwnSurfaces() {
        assertEquals("synara", workspace.defaultThreadTarget()?.id)
    }

    @Test
    fun keepsTheServerOrderBetweenTwoRealProjects() {
        val reordered = listOf(project("Slide", ProjectKind.PROJECT), project("synara", ProjectKind.PROJECT))
        assertEquals("Slide", reordered.defaultThreadTarget()?.id)
    }

    @Test
    fun anExplicitChoiceWinsEvenWhenItIsASystemProject() {
        assertEquals("Studio", workspace.defaultThreadTarget("Studio")?.id)
    }

    @Test
    fun aStaleSelectionFallsBackRatherThanVanishing() {
        assertEquals("synara", workspace.defaultThreadTarget("deleted-project")?.id)
    }

    @Test
    fun aFreshWorkspaceLandsInHomeRatherThanStudio() {
        // Both are seeded by the server, and Studio is listed first — which is how ad-hoc work
        // ended up in the image workspace.
        val fresh = listOf(project("Studio", ProjectKind.STUDIO), project("Home", ProjectKind.CHAT))
        assertEquals("Home", fresh.defaultThreadTarget()?.id)
    }

    @Test
    fun hasNoTargetWhenThereAreNoProjects() {
        assertNull(emptyList<ProjectItem>().defaultThreadTarget())
    }

    @Test
    fun ordersRealProjectsAheadOfBuiltInsForPicking() {
        assertEquals(
            listOf("synara", "Slide", "Home", "Studio"),
            workspace.orderedForPicking().map { it.id },
        )
    }

    @Test
    fun readsTheKindOffTheWire() {
        assertEquals(ProjectKind.STUDIO, ProjectKind.fromWire("studio"))
        // A server that grows a new kind must not make its projects invisible.
        assertEquals(ProjectKind.PROJECT, ProjectKind.fromWire("something-new"))
        assertEquals(ProjectKind.PROJECT, ProjectKind.fromWire(null))
    }
}
