import { z } from "zod";

const operationBaseSchema = z.object({
  id: z.string().min(1),
  destination: z.enum(["session", "snapshot"]),
  startedAt: z.number().int().nonnegative(),
});

const teleportStageSchema = z.enum([
  "requesting-access",
  "capturing",
  "creating-session",
  "creating-snapshot",
  "opening",
]);

const teleportOperationSchema = z.discriminatedUnion("status", [
  operationBaseSchema.extend({ status: z.literal("running"), stage: teleportStageSchema }),
  operationBaseSchema.extend({
    status: z.literal("succeeded"),
    completedAt: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
  operationBaseSchema.extend({
    status: z.literal("failed"),
    completedAt: z.number().int().nonnegative(),
    error: z.string().min(1),
  }),
]);

export type TeleportOperation = z.infer<typeof teleportOperationSchema>;
export type TeleportStage = z.infer<typeof teleportStageSchema>;

const teleportOperationKey = "apertureCompanionTeleportOperation";
const operationTimeoutMs = 10 * 60 * 1000;

export async function getTeleportOperation(): Promise<TeleportOperation | null> {
  const stored = await chrome.storage.session.get(teleportOperationKey);
  return parseTeleportOperation(stored[teleportOperationKey]);
}

export async function saveTeleportOperation(operation: TeleportOperation): Promise<void> {
  await chrome.storage.session.set({
    [teleportOperationKey]: teleportOperationSchema.parse(operation),
  });
}

export async function clearCompletedTeleportOperation(id: string): Promise<void> {
  const operation = await getTeleportOperation();
  if (operation?.id === id && !isTeleportOperationRunning(operation)) {
    await chrome.storage.session.remove(teleportOperationKey);
  }
}

export function subscribeToTeleportOperation(
  listener: (operation: TeleportOperation | null) => void,
): () => void {
  const handleChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: chrome.storage.AreaName,
  ) => {
    if (areaName !== "session" || !(teleportOperationKey in changes)) {
      return;
    }
    listener(parseTeleportOperation(changes[teleportOperationKey]?.newValue));
  };
  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}

export function isTeleportOperationRunning(operation: TeleportOperation | null): boolean {
  return operation?.status === "running" && Date.now() - operation.startedAt < operationTimeoutMs;
}

function parseTeleportOperation(value: unknown): TeleportOperation | null {
  const parsed = teleportOperationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
