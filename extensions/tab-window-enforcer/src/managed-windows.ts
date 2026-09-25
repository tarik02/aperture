import { Effect, Option, Schema } from "effect";
import { chromeCall } from "./chrome.ts";

/** Managed window ID → the one tab it holds. Kept in session storage, which outlives the service worker. */
export type ManagedWindows = Record<string, number>;

const ManagedWindows = Schema.Record(Schema.String, Schema.Number);
const decodeManagedWindows = Schema.decodeUnknownOption(ManagedWindows);

export const loadManagedWindows = chromeCall("storage.session.get", () =>
  chrome.storage.session.get("managedWindows"),
).pipe(
  Effect.map(
    ({ managedWindows }): ManagedWindows => ({
      ...Option.getOrElse(decodeManagedWindows(managedWindows), () => ({})),
    }),
  ),
);

export const saveManagedWindows = (managedWindows: ManagedWindows) =>
  chromeCall("storage.session.set", () => chrome.storage.session.set({ managedWindows }));
