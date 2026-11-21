import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** The areas of a session a ticket gives access to, each read, written or both. */
export const Access = Schema.Record(
  Schema.Literals([
    "input",
    "tabs",
    "lease",
    "sound",
    "clipboard",
    "uploads",
    "downloads",
    "recordings",
    "proxy",
    "mcp",
    "cdp",
    "tunnel",
  ]),
  Schema.optional(Schema.Literals(["r", "w", "rw"])),
);
export type Access = typeof Access.Type;

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
