import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AgentGatewayLive } from "./agentGateway/Layers/AgentGateway";
import { AgentGatewayOperationRepositoryLive } from "./agentGateway/Layers/AgentGatewayOperationRepository";
import { AgentGatewayCredentialsWithSecretsLive } from "./agentGateway/Layers/AgentGatewayCredentials";
import { AutomationRunReactorLive } from "./automation/Layers/AutomationRunReactor";
import { AutomationSchedulerLive } from "./automation/Layers/AutomationScheduler";
import { AutomationServiceLive } from "./automation/Layers/AutomationService";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { StudioOutputReactorLive } from "./orchestration/Layers/StudioOutputReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { TurnCheckpointCoordinatorLive } from "./orchestration/Layers/TurnCheckpointCoordinator";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";

import { DevServerManagerLive } from "./devServerManager";
import { KeybindingsLive } from "./keybindings";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitLayerLive, TextGenerationLayerLive } from "./git/runtimeLayer";
import { TerminalLayerLive } from "./terminal/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ProfileStatsQueryLive } from "./profileStats";
import { ProfileStatsArchiveLive } from "./profileStatsArchive";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ExternalMcpRepositoryLive } from "./externalMcp/Layers/ExternalMcpRepository";
import { ExternalMcpServiceLive } from "./externalMcp/Layers/ExternalMcpService";
import { ExternalMcpGatewayLive } from "./externalMcp/Layers/ExternalMcpGateway";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";
import { MobileGatewayLive } from "./mobile/Layers/MobileGateway";
import { MobileWorkspaceAccessLive } from "./mobile/Layers/MobileWorkspaceAccess";
import { ServerInstanceIdentityLive } from "./server/Layers/ServerInstanceIdentity";
import { AutomationRepositoryLive } from "./persistence/Layers/AutomationRepository";
import { ProjectPullRequestPinsLive } from "./persistence/Layers/ProjectPullRequestPins";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns";
import { OrchestrationEventDeliveryRepositoryLive } from "./persistence/Layers/OrchestrationEventDeliveries";
import { ProviderRuntimeEventRepositoryLive } from "./persistence/Layers/ProviderRuntimeEvents";
import { ThreadDiagnosticsQueryLive } from "./diagnostics/Layers/ThreadDiagnosticsQuery";
import { ManagedAttachmentCleanupLive } from "./managedAttachmentCleanup";
import { PullRequestServiceLive } from "./pullRequests/Layers/PullRequestService";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { makeServerProviderLayer } from "./provider/runtimeLayer";
import { ThreadCreationCoordinatorLive } from "./threadCreation/Layers/ThreadCreationCoordinator";
import { ThreadCreationOperationRepositoryLive } from "./threadCreation/Layers/ThreadCreationOperationRepository";

export { makeServerProviderLayer } from "./provider/runtimeLayer";

export function makeServerRuntimeServicesLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
  } = {},
) {
  const agentGatewayCredentialsLayer =
    options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
  const providerHealthLayer = ProviderHealthLive.pipe(Layer.provideMerge(ServerSettingsLive));
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(checkpointStoreLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    OrchestrationLayerLive,
    checkpointStoreLayer,
    checkpointDiffQueryLayer,
    RuntimeReceiptBusLive,
    TurnCheckpointCoordinatorLive,
  );
  const managedAttachmentCleanupLayer = ManagedAttachmentCleanupLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const studioOutputReactorLayer = StudioOutputReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(studioOutputReactorLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const profileStatsArchiveLayer = ProfileStatsArchiveLive.pipe(
    Layer.provideMerge(checkpointStoreLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
    Layer.provideMerge(studioOutputReactorLayer),
  );
  const threadDeletionReactorLayer = ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(profileStatsArchiveLayer),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(TerminalLayerLive),
  );
  // Shares the single memoized TerminalManager with the top-level TerminalLayerLive.
  const devServerManagerLayer = DevServerManagerLive.pipe(Layer.provide(TerminalLayerLive));
  const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  // Pairing credentials are stored as keyed digests, so bootstrap credentials
  // now need the same secret material the session credentials use.
  const bootstrapCredentialLayer = BootstrapCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  const authControlPlaneLayer = AuthControlPlaneLive.pipe(
    Layer.provide(bootstrapCredentialLayer),
    Layer.provide(sessionCredentialLayer),
  );
  const serverAuthLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(bootstrapCredentialLayer),
    Layer.provide(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
  );
  const authServicesLayer = Layer.mergeAll(
    ServerAuthPolicyLive,
    ServerSecretStoreLive,
    bootstrapCredentialLayer,
    sessionCredentialLayer,
    authControlPlaneLayer,
    serverAuthLayer,
  );
  const automationServiceLayer = AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const automationSchedulerLayer = AutomationSchedulerLive.pipe(
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(AutomationRepositoryLive),
  );
  const automationRunReactorLayer = AutomationRunReactorLive.pipe(
    Layer.provideMerge(automationServiceLayer),
  );
  const externalMcpServiceLayer = ExternalMcpServiceLive.pipe(
    Layer.provideMerge(ExternalMcpRepositoryLive),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const externalMcpGatewayLayer = ExternalMcpGatewayLive.pipe(
    Layer.provideMerge(externalMcpServiceLayer),
    Layer.provideMerge(ExternalMcpRepositoryLive),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerHealthLayer),
  );
  const agentGatewayLayer = AgentGatewayLive.pipe(
    Layer.provideMerge(agentGatewayCredentialsLayer),
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(ThreadDiagnosticsQueryLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerHealthLayer),
  );
  const threadCreationCoordinatorLayer = ThreadCreationCoordinatorLive.pipe(
    Layer.provideMerge(ThreadCreationOperationRepositoryLive),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerHealthLayer),
  );
  const mobileWorkspaceAccessLayer = MobileWorkspaceAccessLive.pipe(
    Layer.provide(WorkspaceLayerLive),
  );
  const mobileGatewayLayer = MobileGatewayLive.pipe(
    Layer.provide(ServerInstanceIdentityLive),
    Layer.provide(ServerEnvironmentLive),
    Layer.provide(runtimeServicesLayer),
    Layer.provide(providerHealthLayer),
    Layer.provide(mobileWorkspaceAccessLayer),
    Layer.provide(GitCoreLive),
    Layer.provide(ServerSettingsLive),
    // Constructing the coordinator here runs its startup recovery before any
    // mobile command can be served.
    Layer.provide(threadCreationCoordinatorLayer),
  );
  const pullRequestServiceLayer = PullRequestServiceLive.pipe(
    Layer.provideMerge(GitLayerLive),
    Layer.provideMerge(ProjectPullRequestPinsLive),
    Layer.provideMerge(OrchestrationLayerLive),
  );

  return Layer.mergeAll(
    agentGatewayCredentialsLayer,
    agentGatewayLayer,
    automationServiceLayer,
    automationSchedulerLayer,
    automationRunReactorLayer,
    managedAttachmentCleanupLayer,
    AutomationRepositoryLive,
    AgentGatewayOperationRepositoryLive,
    ThreadCreationOperationRepositoryLive,
    threadCreationCoordinatorLayer,
    ExternalMcpRepositoryLive,
    externalMcpServiceLayer,
    externalMcpGatewayLayer,
    providerHealthLayer,
    ProjectPullRequestPinsLive,
    pullRequestServiceLayer,
    orchestrationReactorLayer,
    providerCommandReactorLayer,
    threadDeletionReactorLayer,
    devServerManagerLayer,
    GitLayerLive,
    TextGenerationLayerLive,
    TerminalLayerLive,
    KeybindingsLive,
    ServerSettingsLive,
    ServerEnvironmentLive,
    ServerInstanceIdentityLive,
    mobileGatewayLayer,
    ProfileStatsQueryLive,
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

/**
 * Compose the two top-level server graphs around one credential layer. Provider
 * adapters issue tokens from this registry and the HTTP gateway verifies those
 * same tokens, so constructing them independently would break scoped MCP.
 */
export function makeServerApplicationLayers() {
  const agentGatewayCredentialsLayer = AgentGatewayCredentialsWithSecretsLive;
  return {
    runtimeServicesLayer: makeServerRuntimeServicesLayer({
      agentGatewayCredentialsLayer,
    }),
    providerLayer: makeServerProviderLayer({ agentGatewayCredentialsLayer }),
  } as const;
}
