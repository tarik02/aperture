import { EventActor, EventDetail, EventKind, EventResource } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done } from "../store/rows.ts";
import type { Event } from "./schemas.ts";
import { EventsStore, type NewEvent, type Sought } from "./store.ts";

const Row = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.DateTimeUtcFromDate,
  kind: EventKind,
  actorKind: EventActor.fields.kind,
  actorId: Schema.NullOr(Schema.String),
  actorName: Schema.NullOr(Schema.String),
  resourceKind: Schema.NullOr(EventResource.fields.kind),
  resourceId: Schema.NullOr(Schema.String),
  resourceLabel: Schema.NullOr(Schema.String),
  ownerId: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  detail: EventDetail,
});

const kept = (row: typeof Row.Type): Event => ({
  id: row.id,
  at: row.occurredAt,
  kind: row.kind,
  actor: { kind: row.actorKind, id: row.actorId, name: row.actorName },
  resource:
    row.resourceKind === null || row.resourceId === null
      ? null
      : { kind: row.resourceKind, id: row.resourceId, label: row.resourceLabel },
  ownerId: row.ownerId,
  workspaceId: row.workspaceId,
  address: row.address,
  detail: row.detail,
});

/** What `LIKE` reads as itself and nothing else. */
const literally = (text: string) => text.replace(/[\\%_]/gu, (letter) => `\\${letter}`);

/** Events in the SQL database. */
export const makeEventsStore = Effect.fn("EventsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("EventsStore.insert")(function* (event: NewEvent) {
    yield* sql`
      INSERT INTO events (
        id, occurred_at, kind, actor_kind, actor_id, actor_name,
        resource_kind, resource_id, resource_label, owner_id, workspace_id, address, detail
      )
      VALUES (
        ${event.id}, ${event.at}, ${event.kind},
        ${event.actor.kind}, ${event.actor.id}, ${event.actor.name},
        ${event.resource?.kind ?? null}, ${event.resource?.id ?? null},
        ${event.resource?.label ?? null}, ${event.ownerId}, ${event.workspaceId},
        ${event.address}, ${JSON.stringify(event.detail)}::jsonb
      )
    `.pipe(done);
  });

  const list = Effect.fn("EventsStore.list")(function* (sought: Sought) {
    // `IN ()` is no SQL: what would be looked for among nothing is left out.
    const among = (column: string, ids: ReadonlyArray<string>) =>
      ids.length === 0 ? [] : [sql`${sql.literal(column)} IN ${sql.in(ids)}`];
    const theirs =
      sought.of === null
        ? undefined
        : [
            ...(sought.of.accountId === null
              ? []
              : [
                  sql`(actor_kind = 'account' AND actor_id = ${sought.of.accountId})`,
                  sql`owner_id = ${sought.of.accountId}`,
                ]),
            ...among("workspace_id", sought.of.workspaces),
          ];
    const held =
      sought.held === null
        ? undefined
        : [
            ...among("resource_id", sought.held.sessions).map(
              (named) => sql`(resource_kind = 'session' AND ${named})`,
            ),
            ...among("resource_id", sought.held.snapshots).map(
              (named) => sql`(resource_kind = 'snapshot' AND ${named})`,
            ),
            ...among("workspace_id", sought.held.workspaces),
          ];
    if (theirs?.length === 0 || held?.length === 0) {
      return [];
    }
    const rows = yield* sql`
      SELECT * FROM events
      WHERE ${sql.and([
        sql`TRUE`,
        ...(theirs === undefined ? [] : [sql.or(theirs)]),
        ...(held === undefined ? [] : [sql.or(held)]),
        ...(sought.kind === undefined ? [] : [sql`kind = ${sought.kind}`]),
        ...(sought.actor === undefined
          ? []
          : [
              sql`(actor_id = ${sought.actor} OR actor_name ILIKE ${`%${literally(sought.actor)}%`})`,
            ]),
        ...(sought.resourceKind === undefined ? [] : [sql`resource_kind = ${sought.resourceKind}`]),
        ...(sought.resourceId === undefined ? [] : [sql`resource_id = ${sought.resourceId}`]),
        ...(sought.workspaceId === undefined ? [] : [sql`workspace_id = ${sought.workspaceId}`]),
        ...(sought.since === undefined ? [] : [sql`occurred_at >= ${sought.since}`]),
        ...(sought.until === undefined ? [] : [sql`occurred_at < ${sought.until}`]),
        ...(sought.before === undefined
          ? []
          : [sql`(occurred_at, id) < (${sought.before.at}, ${sought.before.id}::uuid)`]),
      ])}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${sought.limit}
    `.pipe(all(Row));
    return rows.map(kept);
  });

  const deleteBefore = Effect.fn("EventsStore.deleteBefore")(function* (before: Date) {
    yield* sql`DELETE FROM events WHERE occurred_at < ${before}`.pipe(done);
  });

  return EventsStore.of({ insert, list, deleteBefore });
});

export const layer = Layer.effect(EventsStore, makeEventsStore());
