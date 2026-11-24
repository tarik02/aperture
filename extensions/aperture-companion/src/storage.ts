import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { chromeCall, type ChromeError } from "./chrome.ts";

export type StorageAreaName = "local" | "session";

/** One schema-checked value in extension storage. */
export interface StoredValue<A> {
  /** None when the value is missing or no longer matches its schema. */
  readonly get: Effect.Effect<Option.Option<A>, ChromeError>;
  readonly set: (value: A) => Effect.Effect<void, ChromeError | Schema.SchemaError>;
  readonly remove: Effect.Effect<void, ChromeError>;
  /** The value after each change, from whichever extension context made it. */
  readonly changes: Stream.Stream<Option.Option<A>>;
}

export function storedValue<A, I>(
  areaName: StorageAreaName,
  key: string,
  schema: Schema.Codec<A, I>,
): StoredValue<A> {
  const area = chrome.storage[areaName];
  const decode = Schema.decodeUnknownOption(schema);
  const encode = Schema.encodeEffect(schema);

  return {
    get: chromeCall(`storage.${areaName}.get`, () => area.get(key)).pipe(
      Effect.map((stored) => decode(stored[key])),
    ),
    set: (value) =>
      encode(value).pipe(
        Effect.flatMap((encoded) =>
          chromeCall(`storage.${areaName}.set`, () => area.set({ [key]: encoded })),
        ),
      ),
    remove: chromeCall(`storage.${areaName}.remove`, () => area.remove(key)),
    changes: Stream.callback<Option.Option<A>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (
            changes: Record<string, chrome.storage.StorageChange>,
            changedArea: string,
          ) => {
            const change = changes[key];
            if (changedArea === areaName && change !== undefined) {
              Queue.offerUnsafe(queue, decode(change.newValue));
            }
          };
          chrome.storage.onChanged.addListener(listener);
          return listener;
        }),
        (listener) => Effect.sync(() => chrome.storage.onChanged.removeListener(listener)),
      ),
    ),
  };
}

/** Every value stored in the area under a key starting with `prefix`, that matches the schema. */
export const storedValuesWithPrefix = <A, I>(
  areaName: StorageAreaName,
  prefix: string,
  schema: Schema.Codec<A, I>,
) => {
  const decode = Schema.decodeUnknownOption(schema);
  return chromeCall(`storage.${areaName}.get`, () => chrome.storage[areaName].get(null)).pipe(
    Effect.map((stored) =>
      Object.entries(stored).flatMap(([key, value]) =>
        key.startsWith(prefix) ? Option.toArray(decode(value)) : [],
      ),
    ),
  );
};
