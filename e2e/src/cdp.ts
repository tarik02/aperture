import * as Effect from "effect/Effect";

/** What a DevTools command failed with. */
export class CdpError extends Error {
  constructor(method: string, reason: string) {
    super(`${method}: ${reason}`);
    this.name = "CdpError";
  }
}

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message: string };
}

export interface CdpEvent {
  readonly method: string;
  // DevTools events are as many shapes as there are events; a check reads the one it knows.
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly params: any;
  readonly sessionId: string | undefined;
}

/** A page, or another target, attached through a DevTools connection. */
export interface Attached {
  readonly sessionId: string;
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly call: (method: string, params?: object) => Effect.Effect<any, CdpError>;
  /** Evaluates in the page and gives the value, waiting for it when it is a promise. */
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly evaluate: (expression: string) => Effect.Effect<any, CdpError>;
}

export interface Cdp {
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly call: (
    method: string,
    params?: object,
    sessionId?: string,
  ) => Effect.Effect<any, CdpError>;
  readonly attach: (targetId: string) => Effect.Effect<Attached, CdpError>;
  /** Hears every event from now on; gives how to stop hearing. */
  readonly listen: (listener: (event: CdpEvent) => void) => () => void;
}

/** Connects to a DevTools endpoint for as long as the scope lasts. */
export const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<WebSocket>((opened, failed) => {
          const socket = new WebSocket(url);
          socket.addEventListener("open", () => opened(socket), { once: true });
          socket.addEventListener("error", () => failed(new Error("no connection")), {
            once: true,
          });
        }),
      catch: () => new CdpError("connect", `${url} did not take the connection`),
    }),
    (socket) => Effect.sync(() => socket.close()),
  ).pipe(Effect.map(over));

const over = (socket: WebSocket): Cdp => {
  let last = 0;
  const waiting = new Map<number, (answer: Message) => void>();
  const listeners = new Set<(event: CdpEvent) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
      return;
    }
    if (message.method !== undefined) {
      for (const listener of listeners) {
        listener({
          method: message.method,
          params: message.params ?? {},
          sessionId: message.sessionId,
        });
      }
    }
  });

  const call: Cdp["call"] = (method, params = {}, sessionId) =>
    Effect.callback((resume) => {
      last += 1;
      const id = last;
      waiting.set(id, (answer) =>
        resume(
          answer.error === undefined
            ? Effect.succeed(answer.result ?? {})
            : Effect.fail(new CdpError(method, answer.error.message)),
        ),
      );
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return Effect.sync(() => waiting.delete(id));
    });

  const attach: Cdp["attach"] = (targetId) =>
    call("Target.attachToTarget", { targetId, flatten: true }).pipe(
      Effect.map(({ sessionId }: { sessionId: string }) => {
        const within: Attached["call"] = (method, params) => call(method, params, sessionId);
        return {
          sessionId,
          call: within,
          evaluate: (expression) =>
            within("Runtime.evaluate", {
              expression,
              returnByValue: true,
              awaitPromise: true,
              userGesture: true,
            }).pipe(
              Effect.flatMap((evaluated) =>
                evaluated.exceptionDetails === undefined
                  ? Effect.succeed(evaluated.result?.value)
                  : Effect.fail(
                      new CdpError(
                        "Runtime.evaluate",
                        evaluated.exceptionDetails.exception?.description ??
                          evaluated.exceptionDetails.text,
                      ),
                    ),
              ),
            ),
        };
      }),
    );

  return {
    call,
    attach,
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
