import { ShareRole } from "@aperture-browser/control-api";
import * as Schema from "effect/Schema";

const Told = Schema.Struct({
  sessionId: Schema.String,
  /** Where the session is reached; none for one that is on no node. */
  path: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  role: ShareRole,
  /** What the guest is called there; none until they said. */
  name: Schema.NullOr(Schema.String),
});

/** What a guest's page is told of the link it was opened with. */
export type Link = typeof Told.Type;

/** Why a link lets nobody in, for whoever opened it. */
export class LinkRefused extends Error {
  constructor(readonly status: number) {
    super(
      status === 429
        ? "Too many links that are none came from here. Try again in a minute."
        : "This link lets nobody in any more. Ask whoever shared it for another.",
    );
  }
}

/**
 * Asks about a share link, with its secret when the page first has it and with the name
 * once one is chosen. The browser carries both from then on, to here and to the session.
 */
export const enter = async (
  shareId: string,
  given: { readonly token?: string | undefined; readonly name?: string | undefined },
) => {
  const answer = await fetch(`/api/control/share/${encodeURIComponent(shareId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(given),
  });
  if (!answer.ok) {
    throw new LinkRefused(answer.status);
  }
  return Schema.decodeUnknownSync(Told)(await answer.json());
};
