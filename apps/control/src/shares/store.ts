import type { ShareRole } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Share } from "./schemas.ts";

export interface NewShare {
  readonly id: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly name: string | null;
  readonly role: ShareRole;
  readonly tab: number | null;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/** Where sessions' share links are kept. A session's links are gone with the session. */
export interface SharesStoreShape {
  readonly insert: (share: NewShare) => Effect.Effect<Share>;
  readonly listOf: (sessionId: string) => Effect.Effect<ReadonlyArray<Share>>;
  /** The links an account made, into whatever sessions. */
  readonly listBy: (accountId: string) => Effect.Effect<ReadonlyArray<Share>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Share>>;
  /**
   * The link a secret is of, by the secret's digest, while the link is good: not run out,
   * and made by an account that is not disabled.
   */
  readonly findByTokenHash: (tokenHash: string, now: Date) => Effect.Effect<Option.Option<Share>>;
  /** Deletes a link: it is kept, and found by nothing again. */
  readonly delete: (id: string, at: Date) => Effect.Effect<void>;
  /** Notes that a guest came with a link, unless that was noted after `since`. */
  readonly used: (id: string, now: Date, since: Date) => Effect.Effect<void>;
}

export class SharesStore extends Context.Service<SharesStore, SharesStoreShape>()(
  "@aperture-browser/control/SharesStore",
) {}
