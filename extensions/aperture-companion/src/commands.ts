import { z } from "zod";

export const teleportTabsCommandSchema = z
  .object({
    type: z.literal("teleport-tabs"),
    tabIds: z.array(z.number().int().positive()).min(1).max(50),
    authenticatedTabId: z.number().int().positive(),
    baseSnapshotName: z.string().min(1).optional(),
    label: z.string().optional(),
    tags: z.record(z.string(), z.string()),
    destination: z.enum(["session", "snapshot"]),
    snapshotName: z.string().optional(),
    description: z.string().optional(),
  })
  .superRefine(({ authenticatedTabId, destination, snapshotName, tabIds }, context) => {
    if (!tabIds.includes(authenticatedTabId)) {
      context.addIssue({
        code: "custom",
        message: "The authenticated tab must be teleported",
        path: ["authenticatedTabId"],
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
