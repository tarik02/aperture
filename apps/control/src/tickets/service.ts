import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Issued, TicketRequest } from "./schemas.ts";

export interface TicketsShape {
  /** Signs a ticket for one person into one session, good for as long as tickets are. */
  readonly issue: (ticket: TicketRequest) => Effect.Effect<Issued>;
}

export class Tickets extends Context.Service<Tickets, TicketsShape>()(
  "@aperture-browser/control/Tickets",
) {}
