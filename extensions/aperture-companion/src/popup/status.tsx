import { Alert, AlertDescription } from "@aperture/ui/components/alert";
import { isTeleportOperationRunning, type TeleportOperation } from "../teleport-operation.ts";

export interface Status {
  message: string;
  kind: "neutral" | "error";
}

export function errorStatus(error: unknown): Status {
  return {
    message: error instanceof Error ? error.message : "The operation failed",
    kind: "error",
  };
}

export function StatusAlert({ status }: { status: Status | null }) {
  if (status === null) {
    return null;
  }

  return (
    <Alert variant={status.kind === "error" ? "destructive" : "default"}>
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>
  );
}

export function teleportCreatedStatus(destination: string, warnings: string[]): Status {
  const resource = destination === "snapshot" ? "Snapshot" : "Session";
  return {
    message:
      warnings.length === 0 ? `${resource} created.` : `${resource} created. ${warnings.join(" ")}`,
    kind: "neutral",
  };
}

export function statusFromTeleportOperation(operation: TeleportOperation | null): Status | null {
  if (operation === null) {
    return null;
  }
  if (operation.status === "running") {
    return isTeleportOperationRunning(operation)
      ? null
      : { message: "The previous teleport did not complete", kind: "error" };
  }
  if (operation.status === "failed") {
    return { message: operation.error, kind: "error" };
  }
  return teleportCreatedStatus(operation.destination, operation.warnings);
}

export function teleportProgressLabel(
  operation: TeleportOperation | null,
  preparing: boolean,
): string {
  if (operation?.status === "running" && isTeleportOperationRunning(operation)) {
    switch (operation.stage) {
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
