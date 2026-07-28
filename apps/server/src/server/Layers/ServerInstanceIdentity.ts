import { randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import { version as serverBuild } from "../../../package.json" with { type: "json" };
import { ServerInstanceIdentity } from "../Services/ServerInstanceIdentity";

/**
 * The single generation identifier for this process. Browser compatibility
 * negotiation, the mobile descriptor, and the mobile hello handshake all read
 * this value; minting a second one would let a client believe it is talking to
 * the generation it negotiated with while another surface disagrees.
 */
export const SERVER_INSTANCE_ID = randomUUID();

export const SERVER_BUILD = serverBuild;

export const ServerInstanceIdentityLive = Layer.succeed(ServerInstanceIdentity)({
  getServerInstanceId: Effect.succeed(SERVER_INSTANCE_ID),
  getServerBuild: Effect.succeed(SERVER_BUILD),
});
