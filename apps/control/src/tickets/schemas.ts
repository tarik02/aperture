import type * as DateTime from "effect/DateTime";
import type { Access } from "@aperture-browser/control-api";

/** Who a ticket is for, into which session, and what it lets them do there. */
export interface TicketRequest {
  readonly sessionId: string;
  readonly subject: string;
  readonly name: string;
  readonly access: Access;
  /**
   * When what the ticket is given for ends: it is good no longer than that, and a session
   * socket opened with it is closed then. Without, a socket stays for as long as its client.
   */
  readonly until?: DateTime.Utc | null;
}

export interface Issued {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}
