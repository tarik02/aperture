import type * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
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
  /**
   * The one route of the session the ticket is good at, as a path below the session's
   * own: `/files/recordings/1a2b.mkv`. It is good at every route its access gives, without.
   */
  readonly path?: string;
  /**
   * The number of the one tab of the session the ticket lets its holder see: what tells
   * of the others or shows them is not theirs. Every tab, without.
   */
  readonly tab?: number;
  /** How long it is good for; for as long as tickets are, without. */
  readonly lasts?: Duration.Duration;
}

export interface Issued {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}
