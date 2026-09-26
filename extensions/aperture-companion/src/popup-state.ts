import * as Schema from "effect/Schema";
import { NonEmptyString, TabId, TeleportDestination } from "./schema.ts";
import { storedValue } from "./storage.ts";

export const PopupScreen = Schema.Literals(["home", "tabs", "add-connection"]);
export type PopupScreen = typeof PopupScreen.Type;

/** What the popup showed when it closed, so reopening it continues where the user left. */
export const PopupState = Schema.Struct({
  connectionId: Schema.NullOr(NonEmptyString),
  screen: PopupScreen,
  selectedTabIds: Schema.Array(TabId),
  draftTabIds: Schema.Array(TabId),
  selectedSnapshot: Schema.String,
  destination: TeleportDestination,
  advanced: Schema.Boolean,
  resourceName: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })).check(
    Schema.isMaxLength(100),
  ),
});
export type PopupState = typeof PopupState.Type;

export const popupState = storedValue("session", "apertureCompanionPopupState", PopupState);
