import { Effect, ServiceMap } from "effect";

export interface ServerInstanceIdentityShape {
  /**
   * Identifies this process generation. Clients compare it against the value
   * they negotiated with, so a restart is detected as a distinct generation
   * rather than silently resumed against different in-memory state.
   */
  readonly getServerInstanceId: Effect.Effect<string>;
  readonly getServerBuild: Effect.Effect<string>;
}

export class ServerInstanceIdentity extends ServiceMap.Service<
  ServerInstanceIdentity,
  ServerInstanceIdentityShape
>()("synara/server/Services/ServerInstanceIdentity") {}
