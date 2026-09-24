import { z } from "zod";
import {
  connectCommandSchema,
  teleportTabsCommandSchema,
  type CompanionCommand,
} from "./commands.ts";

const pendingCommandSchema = z.object({
  command: z.union([connectCommandSchema, teleportTabsCommandSchema]),
  origins: z.array(z.string().min(1)).min(1),
  createdAt: z.number().int().nonnegative(),
});

export type PendingCommand = z.infer<typeof pendingCommandSchema>;

const pendingCommandKeyPrefix = "apertureCompanionPendingCommand:";
export const pendingCommandLifetimeMs = 2 * 60 * 1000;

export async function savePendingCommand(
  command: CompanionCommand,
  origins: string[],
  createdAt = Date.now(),
): Promise<PendingCommand> {
  const pending = pendingCommandSchema.parse({ command, origins, createdAt });
  await chrome.storage.session.set({ [pendingCommandKey(command.id)]: pending });
  return pending;
}

export async function getPendingCommand(id: string): Promise<PendingCommand | null> {
  const key = pendingCommandKey(id);
  const stored = await chrome.storage.session.get(key);
  const parsed = pendingCommandSchema.safeParse(stored[key]);
  return parsed.success ? parsed.data : null;
}

export async function listPendingCommands(): Promise<PendingCommand[]> {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored).flatMap(([key, value]) => {
    if (!key.startsWith(pendingCommandKeyPrefix)) {
      return [];
    }
    const parsed = pendingCommandSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function removePendingCommand(id: string): Promise<void> {
  await chrome.storage.session.remove(pendingCommandKey(id));
}

function pendingCommandKey(id: string): string {
  return `${pendingCommandKeyPrefix}${id}`;
}
