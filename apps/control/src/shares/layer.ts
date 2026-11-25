import type { Access, Caller, ShareRole } from "@aperture-browser/control-api";
import * as UrlPath from "@aperture-browser/shared/url-path";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { accountOf } from "../accounts/caller.ts";
import {
  SessionElsewhere,
  SessionHasNoNode,
  SessionNotFound,
  ShareNotFound,
  ShareRefused,
  TooManyTries,
} from "../errors.ts";
import { Events } from "../events/service.ts";
import { Nodes } from "../nodes/service.ts";
import { sessionAt, sessionPath } from "../routing/paths.ts";
import { Sessions } from "../sessions/service.ts";
import type { Session } from "../sessions/schemas.ts";
import { SessionsStore } from "../sessions/store.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { Tickets } from "../tickets/service.ts";
import { after, ago, now } from "../time.ts";
import { type Entered, type Guest, guestsOf, type Share } from "./schemas.ts";
import { Shares } from "./service.ts";
import { SharesStore } from "./store.ts";
import { withinLifetime } from "../policy/data.ts";
import { Policy } from "../policy/service.ts";

/**
 * What each kind of link gives besides watching. Nothing of the session's files, its
 * routing, its automation or its DevTools endpoint is a guest's.
 */
const ACCESS: Record<ShareRole, Access> = {
  watch: {},
  control: { input: "rw", tabs: "rw", lease: "rw", clipboard: "rw", sound: "rw" },
};

const NAME_MOST = 40;
const UNNAMED = "Guest";
/** How many secrets that are no link's one address may try in a while. */
const TRIES = 30;
const TRIES_WITHIN = Duration.minutes(1);
/** How many addresses' tries are kept before those that are over are looked for. */
const TRIED_MOST = 10_000;
/** How exactly it is kept when a link was last used: a guest's page asks many times a minute. */
const USED_WITHIN = Duration.minutes(1);
/** How long a node gets to put a guest out before it is left to the tickets running out. */
const DISMISSED_WITHIN = Duration.seconds(5);

const letters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** What a guest is called among the session's members: one line of what they typed, and not much of it. */
export const guestName = (given: string) => {
  const line = given
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // By what is read as a letter: a name cut inside one would end in half of it.
  const kept = Array.from(letters.segment(line), (letter) => letter.segment).slice(0, NAME_MOST);
  return kept.join("").trim() || UNNAMED;
};

export const makeShares = Effect.fn("Shares.make")(function* () {
  const store = yield* SharesStore;
  const sessions = yield* Sessions;
  const sessionsStore = yield* SessionsStore;
  const nodes = yield* Nodes;
  const tickets = yield* Tickets;
  const settings = yield* Settings;
  const client = yield* HttpClient.HttpClient;
  const events = yield* Events;
  const policy = yield* Policy;
  const crypto = yield* Effect.context<Crypto.Crypto>();
  /** The secrets that were no link's, by where they came from: how many since when. */
  const tried = new Map<string, { count: number; since: number }>();

  /**
   * A link as an event is about it. It is its session's owner's to read of, whoever
   * made it.
   */
  const about = (share: Share, session: Session) =>
    ({
      resource: { kind: "share", id: share.id, label: share.name },
      ownerId: session.accountId,
      workspaceId: session.workspaceId,
    }) as const;

  /**
   * The link a secret is of. The secrets are long and random, so there is nothing to
   * guess them from; one address is held to a few wrong ones a while all the same, so
   * that guessing costs whoever tries more than it costs this program.
   */
  const good = Effect.fn(function* (token: string, from: Option.Option<string>) {
    const at = yield* now;
    const key = Option.getOrElse(from, () => "");
    const before = tried.get(key);
    const counted =
      before !== undefined && at.getTime() - before.since < Duration.toMillis(TRIES_WITHIN)
        ? before
        : undefined;
    if (settings.rateLimit && counted !== undefined && counted.count >= TRIES) {
      return yield* new TooManyTries({ message: "too many links that are none; try later" });
    }
    const share = yield* store.findByTokenHash(yield* Secrets.hash(token), at);
    if (Option.isSome(share)) {
      return share.value;
    }
    if (tried.size >= TRIED_MOST) {
      for (const [address, one] of tried) {
        if (at.getTime() - one.since >= Duration.toMillis(TRIES_WITHIN)) {
          tried.delete(address);
        }
      }
    }
    tried.set(key, { count: (counted?.count ?? 0) + 1, since: counted?.since ?? at.getTime() });
    return yield* new ShareRefused({ message: "this link is not good, or not any more" });
  }, Effect.provide(crypto));

  const noted = (share: Share) =>
    Effect.gen(function* () {
      yield* store.used(share.id, yield* now, yield* ago(USED_WITHIN));
    });

  /** Has the session's node close the sockets of those who are in the session by a link. */
  const dismiss = Effect.fn(function* (share: Share) {
    const session = yield* sessionsStore.find(share.sessionId);
    const node =
      Option.isNone(session) || session.value.nodeId === null
        ? Option.none()
        : yield* nodes.find(session.value.nodeId);
    if (Option.isNone(node)) {
      return;
    }
    const url = UrlPath.make`${UrlPath.raw(node.value.internalUrl)}/sessions/${share.sessionId}/callers/${guestsOf(share.id)}`;
    yield* client
      .execute(
        HttpClientRequest.delete(url).pipe(HttpClientRequest.bearerToken(node.value.operatorToken)),
      )
      .pipe(
        Effect.timeout(DISMISSED_WITHIN),
        // The link is gone either way: who is still in is out when the socket next ends.
        Effect.catch((error) =>
          Effect.logWarning(
            `node ${node.value.name} did not put the guests of a link out: ${error.message}`,
          ),
        ),
      );
  });

  const create = Effect.fn("Shares.create")(function* (
    caller: Caller,
    sessionId: string,
    link: {
      readonly name: string;
      readonly role: ShareRole;
      readonly lasts: Duration.Duration | undefined;
    },
  ) {
    const account = yield* accountOf(caller);
    const session = yield* sessions.acted(caller, sessionId);
    const effective = yield* policy.of({
      workspaceId: session.workspaceId,
      accountId: session.accountId,
      sessionId: session.id,
      pinned: session.pinned,
    });
    yield* withinLifetime(
      effective.shareLinkMaxLifetime,
      "shareLinkMaxLifetime",
      "a share link",
      link.lasts,
      Duration.toSeconds,
    );
    const secret = yield* Secrets.make("aps");
    const share = yield* store.insert({
      id: yield* Secrets.id,
      sessionId,
      accountId: account.id,
      name: link.name,
      role: link.role,
      tokenHash: yield* Secrets.hash(secret),
      createdAt: yield* now,
      expiresAt: link.lasts === undefined ? null : yield* after(link.lasts),
    });
    yield* events.record({
      kind: "share.created",
      ...about(share, session),
      detail: {
        sessionId,
        role: share.role,
        expiresAt: share.expiresAt === null ? null : DateTime.formatIso(share.expiresAt),
      },
    });
    return { share, secret };
  }, Effect.provide(crypto));

  const list = Effect.fn("Shares.list")(function* (caller: Caller, sessionId: string) {
    yield* sessions.get(caller, sessionId);
    return yield* store.listOf(sessionId);
  });

  const revoke = Effect.fn("Shares.revoke")(function* (
    caller: Caller,
    sessionId: string,
    id: string,
  ) {
    const session = yield* sessions.acted(caller, sessionId);
    const share = Option.filter(yield* store.find(id), (found) => found.sessionId === sessionId);
    if (Option.isNone(share)) {
      return yield* new ShareNotFound({ id });
    }
    yield* store.delete(id, yield* now);
    yield* dismiss(share.value);
    yield* events.record({
      kind: "share.revoked",
      ...about(share.value, session),
      detail: { sessionId },
    });
  });

  const enter = Effect.fn("Shares.enter")(function* (
    id: string,
    token: string,
    from: Option.Option<string>,
    joining: Option.Option<string>,
  ) {
    const share = yield* good(token, from);
    const session = yield* sessionsStore.find(share.sessionId);
    // The address and the secret are of one link, or of none.
    if (share.id !== id || Option.isNone(session)) {
      return yield* new ShareRefused({ message: "this link is not good, or not any more" });
    }
    yield* noted(share);
    if (Option.isSome(joining)) {
      yield* events.record({
        kind: "share.joined",
        ...about(share, session.value),
        actor: { kind: "guest", id: guestsOf(share.id), name: joining.value },
        address: Option.getOrNull(from),
        detail: { sessionId: share.sessionId, role: share.role },
      });
    }
    const { nodeId, observedState, unreachableSince } = session.value;
    return {
      share,
      path: nodeId === null ? null : sessionPath(nodeId, share.sessionId),
      running: observedState === "running" && unreachableSince === null,
      expiresAt: share.expiresAt,
    } satisfies Entered;
  });

  const admit = Effect.fn("Shares.admit")(function* (
    uri: string,
    guest: Guest,
    from: Option.Option<string>,
  ) {
    const at = sessionAt(uri);
    if (at === undefined) {
      return yield* new SessionNotFound({ id: uri });
    }
    const share = yield* good(guest.token, from);
    // A link is into one session: at any other path its holder is nobody.
    if (share.sessionId !== at.sessionId) {
      return yield* new ShareRefused({ message: "this link is not into that session" });
    }
    const session = yield* sessionsStore.find(share.sessionId);
    const node =
      Option.isNone(session) || session.value.nodeId === null
        ? Option.none()
        : yield* nodes.find(session.value.nodeId);
    if (Option.isNone(node)) {
      return yield* new SessionHasNoNode({ id: share.sessionId });
    }
    if (node.value.id !== at.nodeId) {
      return yield* new SessionElsewhere({
        id: share.sessionId,
        path: sessionPath(node.value.id, share.sessionId),
      });
    }
    yield* noted(share);
    const issued = yield* tickets.issue({
      sessionId: share.sessionId,
      subject: guestsOf(share.id),
      name: guestName(guest.name),
      access: ACCESS[share.role],
      until: share.expiresAt,
    });
    return issued.ticket;
  });

  return Shares.of({ create, list, revoke, enter, admit });
});

export const layer = Layer.effect(Shares, makeShares());
