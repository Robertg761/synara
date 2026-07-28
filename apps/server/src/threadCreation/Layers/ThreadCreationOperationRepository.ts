import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ThreadCreationOperationRepository,
  type ReserveThreadCreationOperationResult,
  type ThreadCreationOperationRecord,
  type ThreadCreationOperationRepositoryShape,
} from "../Services/ThreadCreationOperationRepository.ts";

interface OperationRow extends Omit<ThreadCreationOperationRecord, "compensationCompleted"> {
  readonly compensationCompleted: number | boolean;
}

const SELECT_COLUMNS = `
  operation_id AS "operationId",
  fingerprint,
  project_id AS "projectId",
  status,
  compensation_phase AS "compensationPhase",
  blocked_reason AS "blockedReason",
  owned_resources_json AS "ownedResourcesJson",
  request_json AS "requestJson",
  plan_json AS "planJson",
  result_json AS "resultJson",
  error_json AS "errorJson",
  compensation_completed AS "compensationCompleted",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const toRecord = (row: OperationRow): ThreadCreationOperationRecord => ({
  ...row,
  compensationCompleted: row.compensationCompleted === true || row.compensationCompleted === 1,
});

const mapSqlError = (operation: string) => (cause: unknown) =>
  new Error(`Thread creation operation repository failed during ${operation}.`, { cause });

export const makeThreadCreationOperationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readById = (operationId: string) =>
    sql<OperationRow>`
      SELECT ${sql.literal(SELECT_COLUMNS)}
      FROM thread_creation_operations
      WHERE operation_id = ${operationId}
      LIMIT 1
    `;

  const reserve: ThreadCreationOperationRepositoryShape["reserve"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly operationId: string }>`
            INSERT INTO thread_creation_operations (
              operation_id,
              fingerprint,
              project_id,
              status,
              compensation_phase,
              blocked_reason,
              owned_resources_json,
              request_json,
              plan_json,
              result_json,
              error_json,
              compensation_completed,
              created_at,
              updated_at
            ) VALUES (
              ${input.operationId},
              ${input.fingerprint},
              ${input.projectId},
              'reserved',
              NULL,
              NULL,
              NULL,
              ${input.requestJson},
              NULL,
              NULL,
              NULL,
              0,
              ${input.now},
              ${input.now}
            )
            ON CONFLICT (operation_id) DO NOTHING
            RETURNING operation_id AS "operationId"
          `;
          const [row] = yield* readById(input.operationId);
          if (!row) {
            return yield* Effect.fail(
              new Error("Reserved thread creation operation could not be read back."),
            );
          }
          const operation = toRecord(row);
          const kind: ReserveThreadCreationOperationResult["kind"] =
            inserted.length > 0
              ? "reserved"
              : operation.fingerprint === input.fingerprint
                ? "replay"
                : "idempotency_conflict";
          return { kind, operation } satisfies ReserveThreadCreationOperationResult;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("reserve")));

  const recordProgress: ThreadCreationOperationRepositoryShape["recordProgress"] = (input) =>
    sql<{ readonly operationId: string }>`
      UPDATE thread_creation_operations
      SET status = ${input.status}, plan_json = ${input.planJson}, updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND status = ${input.expectedStatus}
        AND plan_json IS ${input.expectedPlanJson}
      RETURNING operation_id AS "operationId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapSqlError("recordProgress")),
    );

  const markCompensating: ThreadCreationOperationRepositoryShape["markCompensating"] = (input) =>
    sql`
      UPDATE thread_creation_operations
      SET status = 'compensating',
          compensation_phase = ${input.phase},
          error_json = ${input.errorJson},
          updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND status NOT IN ('completed', 'failed', 'blocked')
    `.pipe(Effect.asVoid, Effect.mapError(mapSqlError("markCompensating")));

  const block: ThreadCreationOperationRepositoryShape["block"] = (input) =>
    sql`
      UPDATE thread_creation_operations
      SET status = 'blocked',
          compensation_phase = NULL,
          blocked_reason = ${input.reason},
          owned_resources_json = ${input.ownedResourcesJson},
          error_json = ${input.errorJson},
          updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND status NOT IN ('completed', 'failed')
    `.pipe(Effect.asVoid, Effect.mapError(mapSqlError("block")));

  const complete: ThreadCreationOperationRepositoryShape["complete"] = (input) =>
    sql`
      UPDATE thread_creation_operations
      SET status = 'completed',
          compensation_phase = NULL,
          blocked_reason = NULL,
          owned_resources_json = NULL,
          result_json = ${input.resultJson},
          error_json = NULL,
          updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND status <> 'failed'
    `.pipe(Effect.asVoid, Effect.mapError(mapSqlError("complete")));

  const fail: ThreadCreationOperationRepositoryShape["fail"] = (input) =>
    sql`
      UPDATE thread_creation_operations
      SET status = 'failed',
          compensation_phase = NULL,
          blocked_reason = NULL,
          error_json = ${input.errorJson},
          compensation_completed = ${input.compensationCompleted ? 1 : 0},
          updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND status <> 'completed'
    `.pipe(Effect.asVoid, Effect.mapError(mapSqlError("fail")));

  const getById: ThreadCreationOperationRepositoryShape["getById"] = (operationId) =>
    readById(operationId).pipe(
      Effect.map((rows) => (rows[0] ? toRecord(rows[0]) : null)),
      Effect.mapError(mapSqlError("getById")),
    );

  const listNonTerminal: ThreadCreationOperationRepositoryShape["listNonTerminal"] = () =>
    sql<OperationRow>`
      SELECT ${sql.literal(SELECT_COLUMNS)}
      FROM thread_creation_operations
      WHERE status IN (
        'reserved',
        'creating-worktree',
        'creating-thread',
        'starting-turn',
        'compensating'
      )
      ORDER BY created_at ASC, operation_id ASC
    `.pipe(
      Effect.map((rows) => rows.map(toRecord)),
      Effect.mapError(mapSqlError("listNonTerminal")),
    );

  return {
    reserve,
    recordProgress,
    markCompensating,
    block,
    complete,
    fail,
    getById,
    listNonTerminal,
  } satisfies ThreadCreationOperationRepositoryShape;
});

export const ThreadCreationOperationRepositoryLive = Layer.effect(
  ThreadCreationOperationRepository,
  makeThreadCreationOperationRepository,
);
