import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Issued, TicketRequest } from "./schemas.ts";

export interface TicketsShape {
  /** Signs a ticket for one person into one session, good for as long as tickets are. */
  readonly issue: (ticket: TicketRequest) => Effect.Effect<Issued>;
  /**
   * The session a ticket is into, where it was signed here and is still good; nothing for
   * anything else. What it gives there is for the session's node to say.
   */
  readonly sessionOf: (ticket: string) => Effect.Effect<Option.Option<string>>;
}

export class Tickets extends Context.Service<Tickets, TicketsShape>()(
  "@aperture-browser/control/Tickets",
) {}
