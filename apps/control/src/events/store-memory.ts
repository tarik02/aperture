import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Memory, moment } from "../store/memory.ts";
import type { Event } from "./schemas.ts";
import { EventsStore, type NewEvent, type Sought } from "./store.ts";

/** Whether an event is one of those looked for, but for where among them it comes. */
const sought = (event: Event, asked: Sought) => {
  const at = DateTime.toEpochMillis(event.at);
  const about = event.resource;
  return (
    (asked.of === null ||
      (asked.of.accountId !== null &&
        ((event.actor.kind === "account" && event.actor.id === asked.of.accountId) ||
          event.ownerId === asked.of.accountId)) ||
      (event.workspaceId !== null && asked.of.workspaces.includes(event.workspaceId))) &&
    (asked.held === null ||
      (about?.kind === "session" && asked.held.sessions.includes(about.id)) ||
      (about?.kind === "snapshot" && asked.held.snapshots.includes(about.id)) ||
      (event.workspaceId !== null && asked.held.workspaces.includes(event.workspaceId))) &&
    (asked.kind === undefined || event.kind === asked.kind) &&
    (asked.actor === undefined ||
      event.actor.id === asked.actor ||
      (event.actor.name ?? "").toLowerCase().includes(asked.actor.toLowerCase())) &&
    (asked.resourceKind === undefined || about?.kind === asked.resourceKind) &&
    (asked.resourceId === undefined || about?.id === asked.resourceId) &&
    (asked.workspaceId === undefined || event.workspaceId === asked.workspaceId) &&
    (asked.since === undefined || at >= asked.since.getTime()) &&
    (asked.until === undefined || at < asked.until.getTime()) &&
    (asked.before === undefined ||
      at < asked.before.at.getTime() ||
      (at === asked.before.at.getTime() && event.id < asked.before.id))
  );
};

/** Events kept in memory. */
export const makeEventsStoreMemory = Effect.fn("EventsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const insert = Effect.fn("EventsStore.insert")((event: NewEvent) =>
    Effect.sync(() => {
      memory.events.set(event.id, { ...event, at: moment(event.at) });
    }),
  );

  const list = Effect.fn("EventsStore.list")((asked: Sought) =>
    Effect.sync(() =>
      [...memory.events.values()]
        .filter((event) => sought(event, asked))
        .toSorted(
          (one, other) =>
            DateTime.toEpochMillis(other.at) - DateTime.toEpochMillis(one.at) ||
            (other.id < one.id ? -1 : other.id > one.id ? 1 : 0),
        )
        .slice(0, asked.limit),
    ),
  );

  const deleteBefore = Effect.fn("EventsStore.deleteBefore")((before: Date) =>
    Effect.sync(() => {
      for (const event of memory.events.values()) {
        if (DateTime.toEpochMillis(event.at) < before.getTime()) {
          memory.events.delete(event.id);
        }
      }
    }),
  );

  return EventsStore.of({ insert, list, deleteBefore });
});

export const layerTest = Layer.effect(EventsStore, makeEventsStoreMemory());
