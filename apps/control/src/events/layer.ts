import { type Caller, covers, EVENTS_MOST } from "@aperture-browser/control-api";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Forbidden } from "../errors.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { ago, now } from "../time.ts";
import { Doer } from "./doer.ts";
import type { Event } from "./schemas.ts";
import { type Asked, Events, type Happened } from "./service.ts";
import { EventsStore } from "./store.ts";

const LIMIT = 50;

/** What the events before one are asked for with: its moment and its id. */
const cursorOf = (event: Event) => `${DateTime.toEpochMillis(event.at)}_${event.id}`;

/** The event a cursor names. It was read as one where it came in. */
const named = (cursor: string) => {
  const [at = "", id = ""] = cursor.split("_");
  return { at: new Date(Number(at)), id };
};

export const makeEvents = Effect.fn("Events.make")(function* () {
  const store = yield* EventsStore;
  const settings = yield* Settings;
  const crypto = yield* Effect.context<Crypto.Crypto>();

  const record = Effect.fn("Events.record")(
    function* (event: Happened) {
      const doer = yield* Doer;
      yield* store.insert({
        id: yield* Secrets.id,
        at: yield* now,
        kind: event.kind,
        actor: event.actor ?? doer.actor,
        resource: event.resource ?? null,
        ownerId: event.ownerId ?? null,
        workspaceId: event.workspaceId ?? null,
        address: event.address === undefined ? doer.address : event.address,
        detail: event.detail ?? {},
      });
    },
    Effect.provide(crypto),
    // What was done stays done, whether or not it could be written down.
    (recorded, event) =>
      Effect.catchCause(recorded, (cause) =>
        Effect.logWarning(`an event was not recorded: ${event.kind}`, cause),
      ),
  );

  const list = Effect.fn("Events.list")(function* (caller: Caller, asked: Asked) {
    if (!caller.admin && !covers(caller.scopes, "events:read")) {
      return yield* new Forbidden({ message: "this token is not for events:read" });
    }
    const limit = Math.min(asked.limit ?? LIMIT, EVENTS_MOST);
    // One more than is told, to know whether there are any before these.
    const found = yield* store.list({
      of: caller.admin
        ? null
        : {
            accountId: Option.getOrNull(Option.map(caller.account, (account) => account.id)),
            workspaces: caller.workspaces.map((workspace) => workspace.id),
          },
      held: caller.resources,
      kind: asked.kind,
      actor: asked.actor,
      resourceKind: asked.resourceKind,
      resourceId: asked.resourceId,
      workspaceId: asked.workspaceId,
      since: asked.since,
      until: asked.until,
      before: asked.cursor === undefined ? undefined : named(asked.cursor),
      limit: limit + 1,
    });
    const events = found.slice(0, limit);
    const last = events.at(-1);
    return { events, next: found.length > limit && last !== undefined ? cursorOf(last) : null };
  });

  const forget = Effect.fn("Events.forget")(function* () {
    yield* store.deleteBefore(yield* ago(settings.eventsKeep));
  });

  return Events.of({ record, list, forget });
});

export const layer = Layer.effect(Events, makeEvents());
