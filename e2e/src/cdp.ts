import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

/** What a DevTools command failed with. */
export class CdpError extends Schema.TaggedError<CdpError>()("CdpError", {
  method: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.method}: ${this.reason}`;
  }
}

const Message = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  sessionId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});

const messageOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Message));

export interface CdpEvent {
  readonly method: string;
  // DevTools events are as many shapes as there are events; a check reads the one it knows.
  readonly params: unknown;
  readonly sessionId: string | undefined;
}

/** What a check reads of an answer: a schema of the part it knows. */
export type Known = Schema.ConstraintDecoder<unknown>;

/** A DevTools command. Its result is as the schema reads it, and unknown without one. */
export interface Call {
  (method: string, params?: object): Effect.Effect<unknown, CdpError>;
  <S extends Known>(method: string, params: object, result: S): Effect.Effect<S["Type"], CdpError>;
}

/** Evaluates in the page and gives the value, waiting for it when it is a promise. */
export interface Evaluate {
  (expression: string): Effect.Effect<unknown, CdpError>;
  <S extends Known>(expression: string, value: S): Effect.Effect<S["Type"], CdpError>;
}

/** A page, or another target, attached through a DevTools connection. */
export interface Attached {
  readonly sessionId: string;
  readonly call: Call;
  readonly evaluate: Evaluate;
}

export interface Cdp {
  readonly call: Call;
  readonly attach: (targetId: string) => Effect.Effect<Attached, CdpError>;
  /** Every event from when this is asked for until the scope ends. */
  readonly events: Effect.Effect<PubSub.Subscription<CdpEvent>, never, Scope.Scope>;
}

const AttachedTo = Schema.Struct({ sessionId: Schema.String });

/** What DevTools tells of something a page threw. */
export const ExceptionDetails = Schema.Struct({
  text: Schema.String,
  exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })),
});

const Evaluated = Schema.Struct({
  result: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
  exceptionDetails: Schema.optional(ExceptionDetails),
});

const GONE = "the connection is gone";

/** Connects to a DevTools endpoint for as long as the scope lasts. */
export const connect = Effect.fn("Cdp.connect")(function* (url: string) {
  const socket = yield* Socket.makeWebSocket(url);
  const pull = yield* Socket.readerString(socket).pipe(
    Effect.mapError(
      () => new CdpError({ method: "connect", reason: `${url} did not take the connection` }),
    ),
  );
  const writer = yield* socket.writer;
  const events = yield* PubSub.unbounded<CdpEvent>();

  let last = 0;
  let gone = false;
  const waiting = new Map<number, Deferred.Deferred<unknown, CdpError>>();

  const heard = Effect.fn(function* (frame: string) {
    const message = yield* messageOf(frame);
    if (message.id !== undefined) {
      const asked = waiting.get(message.id);
      if (asked !== undefined) {
        yield* message.error === undefined
          ? Deferred.succeed(asked, message.result ?? {})
          : Deferred.fail(asked, new CdpError({ method: "", reason: message.error.message }));
      }
      return;
    }
    if (message.method !== undefined) {
      yield* PubSub.publish(events, {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId,
      });
    }
  });

  yield* pull.pipe(
    // A frame that is no DevTools message is nothing a check waits for.
    Effect.flatMap(Effect.forEach((frame) => Effect.ignore(heard(frame)), { discard: true })),
    Effect.forever,
    Effect.catch(() =>
      Effect.suspend(() => {
        gone = true;
        return Effect.forEach(
          waiting.values(),
          (asked) => Deferred.fail(asked, new CdpError({ method: "", reason: GONE })),
          { discard: true },
        );
      }),
    ),
    Effect.forkScoped,
  );

  const ask = (method: string, params: object, sessionId: string | undefined) =>
    Effect.suspend(() => {
      if (gone) {
        return Effect.fail(new CdpError({ method, reason: GONE }));
      }
      last += 1;
      const id = last;
      return Effect.gen(function* () {
        const answer = yield* Deferred.make<unknown, CdpError>();
        waiting.set(id, answer);
        yield* writer
          .write(JSON.stringify({ id, method, params, sessionId }))
          .pipe(Effect.mapError(() => new CdpError({ method, reason: GONE })));
        return yield* Deferred.await(answer);
      }).pipe(
        Effect.mapError((error) => new CdpError({ method, reason: error.reason })),
        Effect.ensuring(Effect.sync(() => waiting.delete(id))),
      );
    });

  const callIn = (sessionId: string | undefined): Call => {
    function call(method: string, params?: object): Effect.Effect<unknown, CdpError>;
    function call<S extends Known>(
      method: string,
      params: object,
      result: S,
    ): Effect.Effect<S["Type"], CdpError>;
    function call(method: string, params: object = {}, result: Known = Schema.Unknown) {
      return ask(method, params, sessionId).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(result)),
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(new CdpError({ method, reason: error.message })),
        ),
      );
    }
    return call;
  };

  const browser = callIn(undefined);

  const attach: Cdp["attach"] = (targetId) =>
    browser("Target.attachToTarget", { targetId, flatten: true }, AttachedTo).pipe(
      Effect.map(({ sessionId }) => {
        const within = callIn(sessionId);
        function evaluate(expression: string): Effect.Effect<unknown, CdpError>;
        function evaluate<S extends Known>(
          expression: string,
          value: S,
        ): Effect.Effect<S["Type"], CdpError>;
        function evaluate(expression: string, value: Known = Schema.Unknown) {
          const method = "Runtime.evaluate";
          return within(
            method,
            { expression, returnByValue: true, awaitPromise: true, userGesture: true },
            Evaluated,
          ).pipe(
            Effect.flatMap((evaluated) =>
              evaluated.exceptionDetails === undefined
                ? Effect.succeed(evaluated.result?.value)
                : Effect.fail(
                    new CdpError({
                      method,
                      reason:
                        evaluated.exceptionDetails.exception?.description ??
                        evaluated.exceptionDetails.text,
                    }),
                  ),
            ),
            Effect.flatMap(Schema.decodeUnknownEffect(value)),
            Effect.catchTag("SchemaError", (error) =>
              Effect.fail(
                new CdpError({ method, reason: `${expression} is not as read: ${error.message}` }),
              ),
            ),
          );
        }
        return { sessionId, call: within, evaluate } satisfies Attached;
      }),
    );

  return { call: browser, attach, events: PubSub.subscribe(events) } satisfies Cdp;
});
