import type { Caller, ShareRole } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type {
  Forbidden,
  SessionElsewhere,
  SessionHasNoNode,
  SessionNotFound,
  ShareNotFound,
  ShareRefused,
  TooManyTries,
} from "../errors.ts";
import type { Entered, Guest, Share } from "./schemas.ts";

/** What a guest's coming with a link may come to. `from` is where they came from. */
export type GuestError = ShareRefused | TooManyTries;

/**
 * Share links: what lets someone with no account into one session, to watch it or to
 * control it, for as long as whoever has the session lets them.
 */
export interface SharesShape {
  /** A new link into the caller's session. The secret is told here and kept nowhere. */
  readonly create: (
    caller: Caller,
    sessionId: string,
    link: {
      /** Whom it is for; nobody named, without. */
      readonly name: string | undefined;
      readonly role: ShareRole;
      /** The number of the one tab its guests see; the whole session, without. */
      readonly tab: number | undefined;
      /** How long it is good for; for as long as it is not taken back, without. */
      readonly lasts: Duration.Duration | undefined;
    },
  ) => Effect.Effect<
    { readonly share: Share; readonly secret: string },
    Forbidden | SessionNotFound
  >;
  /** The links into the caller's session, those that ran out among them. */
  readonly list: (
    caller: Caller,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<Share>, SessionNotFound>;
  /**
   * Takes a link back: no guest gets in with it from then on, and those who are in the
   * session by it are put out, where its node is reached.
   */
  readonly revoke: (
    caller: Caller,
    sessionId: string,
    id: string,
  ) => Effect.Effect<void, Forbidden | SessionNotFound | ShareNotFound>;
  /**
   * The link a guest came with, by its id and its secret, where its session is, and what
   * the guest is called there. A link whose account is disabled lets nobody in until the
   * account is in use again.
   */
  readonly enter: (
    id: string,
    token: string,
    from: Option.Option<string>,
    named: {
      /** What the guest says they are to be called, when they say it now. */
      readonly said: Option.Option<string>;
      /**
       * What they were called before, as their browser carries it: none for a guest who
       * comes for the first time, which is their joining. Without either they are given
       * a name.
       */
      readonly kept: Option.Option<string>;
    },
  ) => Effect.Effect<Entered, GuestError>;
  /**
   * Lets a guest's request to the path of the link's session pass, and to no other path:
   * a ticket of what the link gives, in the name the guest chose.
   */
  readonly admit: (
    uri: string,
    guest: Guest,
    from: Option.Option<string>,
  ) => Effect.Effect<string, GuestError | SessionNotFound | SessionHasNoNode | SessionElsewhere>;
}

export class Shares extends Context.Service<Shares, SharesShape>()(
  "@aperture-browser/control/Shares",
) {}
