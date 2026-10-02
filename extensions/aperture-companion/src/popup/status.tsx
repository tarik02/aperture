import { Alert, AlertDescription } from "@aperture-browser/ui/components/alert";
import type * as Cause from "effect/Cause";
import { failureMessage } from "../errors.ts";
import type { TeleportDestination } from "../schema.ts";
import { isTeleportRunning, type TeleportOperation } from "../teleport-operation.ts";

export interface Status {
  message: string;
  kind: "neutral" | "error";
}

export function failureStatus(cause: Cause.Cause<unknown>): Status {
  return { message: failureMessage(cause), kind: "error" };
}

export function StatusAlert({ status }: { status: Status | null }) {
  if (status === null) return null;

  return (
    <Alert variant={status.kind === "error" ? "destructive" : "default"}>
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>
  );
}

export function teleportCreatedStatus(
  destination: TeleportDestination,
  warnings: readonly string[],
): Status {
  const resource = destination === "snapshot" ? "Snapshot" : "Session";
  return {
    message:
      warnings.length === 0 ? `${resource} created.` : `${resource} created. ${warnings.join(" ")}`,
    kind: "neutral",
  };
}

export function statusFromTeleportOperation(operation: TeleportOperation | null): Status | null {
  switch (operation?.status) {
    case undefined:
      return null;
    case "running":
      return isTeleportRunning(operation)
        ? null
        : { message: "The previous teleport did not complete", kind: "error" };
    case "failed":
      return { message: operation.error, kind: "error" };
    case "succeeded":
      return teleportCreatedStatus(operation.destination, operation.warnings);
  }
}

export function teleportProgressLabel(
  operation: TeleportOperation | null,
  preparing: boolean,
): string {
  if (isTeleportRunning(operation)) {
    switch (operation.stage) {
      case "requesting-access":
        return "Waiting for site access…";
      case "capturing":
        return "Capturing state…";
      case "creating-session":
        return "Restoring in Aperture…";
      case "creating-snapshot":
        return "Creating snapshot…";
      case "opening":
        return "Opening Aperture…";
    }
  }
  return preparing ? "Preparing…" : "Teleport";
}
