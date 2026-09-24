import { z } from "zod";

export const connectCommandSchema = z.object({
  type: z.literal("connect"),
  id: z.string().min(1),
  origin: z.string(),
  token: z.string(),
});

export const connectResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), connectionId: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export const teleportTabsCommandSchema = z
  .object({
    type: z.literal("teleport-tabs"),
    id: z.string().min(1),
    tabIds: z.array(z.number().int().positive()).min(1).max(50),
    activeTabId: z.number().int().positive(),
    baseSnapshotName: z.string().min(1).optional(),
    label: z.string().optional(),
    tags: z.record(z.string(), z.string()),
    destination: z.enum(["session", "snapshot"]),
    snapshotName: z.string().optional(),
    description: z.string().optional(),
  })
  .superRefine(({ activeTabId, destination, snapshotName, tabIds }, context) => {
    if (!tabIds.includes(activeTabId)) {
      context.addIssue({
        code: "custom",
        message: "The active tab must be teleported",
        path: ["activeTabId"],
      });
    }
    if (destination === "snapshot" && !snapshotName?.trim()) {
      context.addIssue({
        code: "custom",
        message: "Snapshot name is required",
        path: ["snapshotName"],
      });
    }
  });

export const teleportTabsResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    warnings: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type TeleportTabsCommand = z.infer<typeof teleportTabsCommandSchema>;
export type ConnectCommand = z.infer<typeof connectCommandSchema>;
export type CompanionCommand = ConnectCommand | TeleportTabsCommand;
