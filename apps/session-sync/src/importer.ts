// FILE: importer.ts
// Purpose: Places discovered provider sessions under Synara projects and imports them.
// Layer: Session-sync pipeline

import { basename } from "node:path";

import {
  CommandId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type ModelSelection,
} from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

import type { DiscoveredSession, SyncProvider } from "./types.ts";
import type { SynaraConnection } from "./synara/synaraClient.ts";

export interface ImporterOptions {
  readonly platform: string;
  readonly defaultClaudeModel: string;
  readonly defaultCodexModel: string;
}

interface ShellProject {
  readonly id: string;
  readonly kind?: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection?: ModelSelection | null;
}

export type ImportSessionResult =
  | { readonly outcome: "imported"; readonly threadId: string }
  | { readonly outcome: "already-bound" };

function commandId(): ReturnType<typeof CommandId.makeUnsafe> {
  return CommandId.makeUnsafe(crypto.randomUUID());
}

function modelSelectionFor(
  provider: SyncProvider,
  projectDefault: ModelSelection | null | undefined,
  options: ImporterOptions,
): ModelSelection {
  if (projectDefault && "provider" in projectDefault && projectDefault.provider === provider) {
    return projectDefault;
  }
  return provider === "claudeAgent"
    ? { provider: "claudeAgent", model: options.defaultClaudeModel }
    : { provider: "codex", model: options.defaultCodexModel };
}

function deriveTitle(session: DiscoveredSession): string {
  const source = session.title?.trim();
  if (source && source.length > 0) {
    return source.length > 80 ? `${source.slice(0, 77)}…` : source;
  }
  return `${session.provider} ${session.externalId.slice(0, 8)}`;
}

export class SynaraImporter {
  constructor(
    private readonly connection: SynaraConnection,
    private readonly options: ImporterOptions,
  ) {}

  /** Finds the project owning `cwd`, creating it when the workspace is new. */
  async ensureProjectId(
    cwd: string,
  ): Promise<{ projectId: string; defaultModelSelection: ModelSelection | null }> {
    const snapshot = await this.connection.shellSnapshot();
    const existing = snapshot.projects.find(
      (project: ShellProject) =>
        (project.kind ?? "project") === "project" &&
        workspaceRootsEqual(project.workspaceRoot, cwd, { platform: this.options.platform }),
    );
    if (existing) {
      return {
        projectId: existing.id,
        defaultModelSelection: existing.defaultModelSelection ?? null,
      };
    }

    const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
    await this.connection.dispatchCommand({
      type: "project.create",
      commandId: commandId(),
      projectId,
      title: basename(cwd) || cwd,
      workspaceRoot: cwd,
      createdAt: new Date().toISOString(),
    } as ClientOrchestrationCommand);
    return { projectId, defaultModelSelection: null };
  }

  /**
   * Imports one session: ensures the project, creates a placeholder thread,
   * then hands both to orchestration.importThread which binds the provider
   * session and replays its history.
   */
  async importSession(session: DiscoveredSession): Promise<ImportSessionResult> {
    const { projectId, defaultModelSelection } = await this.ensureProjectId(session.cwd);

    const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
    await this.connection.dispatchCommand({
      type: "thread.create",
      commandId: commandId(),
      threadId,
      projectId: ProjectId.makeUnsafe(projectId),
      title: deriveTitle(session),
      modelSelection: modelSelectionFor(session.provider, defaultModelSelection, this.options),
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      creationSource: "provider_native",
      createdAt: new Date().toISOString(),
    } as ClientOrchestrationCommand);

    try {
      await this.connection.importThread({ threadId, externalId: session.externalId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A concurrent import (manual mod+i while the daemon worked) leaves a
      // bound thread behind; that satisfies the goal, so treat it as done.
      if (message.includes("already has an active provider session")) {
        return { outcome: "already-bound" };
      }
      // Otherwise remove the placeholder so failed imports never litter the
      // sidebar with empty threads; the session stays queued for retry.
      await this.deleteThreadQuietly(threadId);
      throw new Error(
        `Import failed for ${session.provider} session ${session.externalId}: ${message}`,
        { cause },
      );
    }

    return { outcome: "imported", threadId };
  }

  private async deleteThreadQuietly(threadId: ThreadId): Promise<void> {
    try {
      await this.connection.dispatchCommand({
        type: "thread.delete",
        commandId: commandId(),
        threadId,
      } as ClientOrchestrationCommand);
    } catch {
      // Best effort only; the original import error matters more.
    }
  }
}
