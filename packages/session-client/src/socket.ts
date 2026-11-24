import {
  create,
  fromBinary,
  fromJsonString,
  type MessageInitShape,
  toBinary,
} from "@bufbuild/protobuf";
import * as Effect from "effect/Effect";
import {
  ClientMessageSchema,
  type ServerMessage,
  ServerMessageSchema,
} from "./gen/aperture/live/v1/live_pb.ts";

/** A message to the session: one case of `ClientMessage`. */
export type Outgoing = Exclude<
  NonNullable<MessageInitShape<typeof ClientMessageSchema>["message"]>,
  { case: undefined }
>;

/** A message from the session: one case of `ServerMessage`. */
export type Incoming = Exclude<ServerMessage["message"], { case: undefined }>;

export const encode = (message: Outgoing) =>
  toBinary(ClientMessageSchema, create(ClientMessageSchema, { message }));

export interface Handlers {
  readonly opened: () => void;
  readonly message: (message: Incoming) => void;
  /** The socket closed without this client closing it. */
  readonly closed: (reason: string | undefined) => void;
}

export interface Socket {
  readonly isOpen: () => boolean;
  /** Sends the message as protobuf, which the session then answers in; false when not open. */
  readonly send: (message: Outgoing) => boolean;
}

const decode = (data: unknown) => {
  if (typeof data === "string") {
    return fromJsonString(ServerMessageSchema, data, { ignoreUnknownFields: true });
  }
  if (data instanceof ArrayBuffer) {
    return fromBinary(ServerMessageSchema, new Uint8Array(data));
  }
  return undefined;
};

/** Opens the session socket. Closing the scope closes it, and `closed` is not told then. */
export const open = Effect.fn("Socket.open")(function* (url: string, handlers: Handlers) {
  const listening = new AbortController();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const opened = new WebSocket(url);
      opened.binaryType = "arraybuffer";
      return opened;
    }),
    (opened) =>
      Effect.sync(() => {
        listening.abort();
        opened.close();
      }),
  );
  const { signal } = listening;

  socket.addEventListener("open", () => handlers.opened(), { signal });
  socket.addEventListener(
    "message",
    (event) => {
      let decoded: ServerMessage | undefined;
      try {
        decoded = decode(event.data);
      } catch {
        // A message this client cannot read is one of a later protocol: the rest still is.
        return;
      }
      const message = decoded?.message;
      if (message !== undefined && message.case !== undefined) {
        handlers.message(message);
      }
    },
    { signal },
  );
  socket.addEventListener(
    "close",
    (event) => handlers.closed(event.reason === "" ? undefined : event.reason),
    { signal },
  );

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(encode(message));
      return true;
    },
  } satisfies Socket;
});
