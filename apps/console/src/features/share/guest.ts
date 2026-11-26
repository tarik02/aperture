import { ShareRole } from "@aperture-browser/control-api";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { failedToAnswer, Unanswered } from "#/lib/answering.ts";

const Told = Schema.Struct({
  sessionId: Schema.String,
  /** Where the session is reached; none for one that is on no node. */
  path: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  role: ShareRole,
  /** The number of the one tab the link shows; the whole session, without. */
  tab: Schema.NullOr(Schema.Number),
  /** What the guest is called there: what they said, else what the link gave them. */
  name: Schema.String,
});

/** What a guest's page is told of the link it was opened with. */
export type Link = typeof Told.Type;

/** Why a link lets nobody in, for whoever opened it. */
export class LinkRefused extends Data.TaggedError("LinkRefused")<{ readonly status: number }> {
  override get message() {
    return this.status === 429
      ? "Too many links that are none came from here. Try again in a minute."
      : "This link lets nobody in any more. Ask whoever shared it for another.";
  }
}

/**
 * Asks about a share link, with its secret when the page first has it and with a name
 * when one is chosen. The browser carries both from then on, to here and to the session.
 */
export const enter = async (
  shareId: string,
  given: { readonly token?: string | undefined; readonly name?: string | undefined },
) => {
  const answer = await fetch(`/api/control/share/${encodeURIComponent(shareId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(given),
  }).catch(() => {
    throw new Unanswered();
  });
  if (failedToAnswer(answer.status)) {
    throw new Unanswered();
  }
  if (!answer.ok) {
    throw new LinkRefused({ status: answer.status });
  }
  return Schema.decodeUnknownSync(Told)(await answer.json());
};
