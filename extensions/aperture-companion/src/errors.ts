import { ApiRequestError } from "@aperture-browser/api-client";
import * as Cause from "effect/Cause";
import { ChromeError, CompanionError } from "./chrome.ts";
import type { CommandError } from "./commands.ts";

/** What the popup tells the user about a failed operation. */
export function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof CompanionError || error instanceof ApiRequestError) return error.message;
  if (error instanceof ChromeError && error.cause instanceof Error) return error.cause.message;
  return "The operation failed";
}

/** The failure as a command result carries it back to the popup. */
export function commandError(cause: Cause.Cause<unknown>): CommandError {
  const error = Cause.squash(cause);
  if (error instanceof CompanionError || error instanceof ApiRequestError) return error;
  return new CompanionError({ message: failureMessage(cause) });
}
