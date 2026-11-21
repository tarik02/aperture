import type * as DateTime from "effect/DateTime";
import type { Access } from "@aperture-browser/control-api";

/** Who a ticket is for, into which session, and what it lets them do there. */
export interface TicketRequest {
  readonly sessionId: string;
  readonly subject: string;
  readonly name: string;
  readonly access: Access;
}

export interface Issued {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}
