import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type DependencyList,
  type ReactNode,
} from "react";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type { ApiServices } from "@aperture/api-client";
import type { AppRuntime, AppServices } from "#/lib/effect/runtime.ts";

const RuntimeContext = createContext<AppRuntime | null>(null);

/** A hook below needed the app runtime, but no RuntimeProvider is above the component. */
export class RuntimeProviderMissingError extends Data.TaggedError("RuntimeProviderMissingError") {
  override readonly message = "useRuntime must be used inside RuntimeProvider";
}

/** Makes the app runtime available to the hooks below. */
export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime;
  children: ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new RuntimeProviderMissingError();
  }
  return runtime;
}

/**
 * Runs an effect while the component is mounted, restarting it when `deps` change, like
 * `useEffect`. Return `undefined` to run nothing. The fiber is interrupted synchronously
 * on cleanup, so its synchronous finalizers have run before the next effect starts.
 */
export function useFork(
  effect: () => Effect.Effect<unknown, never, AppServices> | undefined,
  deps: DependencyList,
): void {
  const runtime = useRuntime();
  useEffect(() => {
    const program = effect();
    if (!program) {
      return;
    }
    const fiber = runtime.runFork(program);
    return () => fiber.interruptUnsafe();
    // The caller's deps describe `effect`, as with useEffect.
  }, [runtime, ...deps]);
}

/**
 * Returns an event handler that forks the effect `callback` builds. Fibers still running
 * when the component unmounts are interrupted.
 */
export function useEffectCallback<Args extends ReadonlyArray<unknown>>(
  callback: (...args: Args) => Effect.Effect<unknown, never, AppServices>,
  deps: DependencyList,
): (...args: Args) => void {
  const runtime = useRuntime();
  const fibers = useRef(new Set<Fiber.Fiber<unknown>>());

  useEffect(() => {
    const running = fibers.current;
    return () => {
      for (const fiber of running) {
        fiber.interruptUnsafe();
      }
      running.clear();
    };
  }, []);

  return useCallback(
    (...args: Args) => {
      const fiber = runtime.runFork(callback(...args));
      if (fiber.pollUnsafe()) {
        return;
      }
      fibers.current.add(fiber);
      fiber.addObserver(() => fibers.current.delete(fiber));
    },
    // The caller's deps describe `callback`, as with useCallback.
    [runtime, ...deps],
  );
}

/**
 * Returns a function that runs an API call for promise-based callers such as TanStack
 * Query. Aborting the signal interrupts the request.
 */
export function useRunApi() {
  const runtime = useRuntime();
  return useCallback(
    <A, E>(
      call: Effect.Effect<A, E, ApiServices>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<A> => runtime.runPromise(call, options),
    [runtime],
  );
}
