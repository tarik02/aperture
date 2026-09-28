import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Playwright } from "effect-playwright";
import { errors, type CDPSession, type Frame } from "playwright-core";

export interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
}

/** The browser did something the restore cannot continue from. */
export class RestoreError extends Data.TaggedError("RestoreError")<{
  readonly message: string;
}> {}

export const restoreError = (message: string) => new RestoreError({ message });

/**
 * Runs a Playwright call that effect-playwright does not wrap, failing the way its own
 * wrappers do.
 */
export function attempt<A>(
  evaluate: () => Promise<A>,
): Effect.Effect<A, Playwright.PlaywrightError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new Playwright.PlaywrightError({
        reason: cause instanceof errors.TimeoutError ? "Timeout" : "Unknown",
        cause,
      }),
  });
}

/** A Chrome DevTools Protocol session. */
export interface Cdp {
  readonly send: <A = unknown>(
    method: string,
    params?: object,
  ) => Effect.Effect<A, Playwright.PlaywrightError>;
  readonly detach: Effect.Effect<void, Playwright.PlaywrightError>;
}

export function makeCdp(session: CDPSession): Cdp {
  const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
  return {
    send: <A>(method: string, params?: object) =>
      attempt(() => send(method, params)) as Effect.Effect<A, Playwright.PlaywrightError>,
    detach: attempt(() => session.detach()),
  };
}

/** In-process frames share their parent's CDP session; remote frames own one. */
export function cdpForFrame(frame: Frame): Effect.Effect<Cdp, Playwright.PlaywrightError> {
  return attempt(() => frame.page().context().newCDPSession(frame)).pipe(
    Effect.map(makeCdp),
    Effect.catchTag("PlaywrightError", (error) => {
      const parent = frame.parentFrame();
      if (
        parent !== null &&
        error.cause instanceof Error &&
        error.cause.message.endsWith(
          "This frame does not have a separate CDP session, it is a part of the parent frame's session",
        )
      )
        return cdpForFrame(parent);
      return Effect.fail(error);
    }),
  );
}

export const cdpForPage = Effect.fnUntraced(function* (page: Playwright.Page) {
  const cdp = makeCdp(yield* page.use((raw) => raw.context().newCDPSession(raw)));
  const info = yield* cdp.send<{ targetInfo?: TargetInfo }>("Target.getTargetInfo");
  if (!info.targetInfo?.targetId) {
    return yield* restoreError("browser omitted the created target ID");
  }

  return { cdp, id: info.targetInfo.targetId };
});

export const evaluate = Effect.fnUntraced(function* (
  cdp: Cdp,
  expression: string,
  contextId?: number,
) {
  const result = yield* cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    },
  );
  if (result.exceptionDetails || !result.result || !("value" in result.result)) {
    return yield* restoreError("browser could not evaluate the restore runtime");
  }

  return result.result.value;
});
