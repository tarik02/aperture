import { ShareRole } from "@aperture-browser/control-api";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** A share link as it is kept: what it gives and to which session, and never its secret. */
export const Share = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  /** The account that made it. */
  accountId: Schema.String,
  /** What whoever made it calls it; nothing, where they said nothing. */
  name: Schema.NullOr(Schema.String),
  role: ShareRole,
  /** The number of the one tab its guests see; the whole session, without. */
  tab: Schema.NullOr(Schema.Int),
  createdAt: Schema.DateTimeUtcFromDate,
  /** When it stops being good by itself; never, without. */
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  /** When a guest last came with it, to within a minute; never, without. */
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
});
export type Share = typeof Share.Type;

/** Who the guests of a link are to the session's node: by that it puts them out. */
export const guestsOf = (shareId: string) => `share:${shareId}`;

/** A guest as their browser carries them: the link's secret, and what they are called. */
export interface Guest {
  readonly token: string;
  readonly name: string;
}

/** What a guest who came with a link is told of it. */
export interface Entered {
  readonly share: Share;
  /** Where the session is reached; none for a session on no node. */
  readonly path: string | null;
  /** Whether the session runs: one that rests is its owner's to resume. */
  readonly running: boolean;
  readonly expiresAt: DateTime.Utc | null;
  /** What the guest is called among the session's members. */
  readonly name: string;
}
