import { z } from "zod";

const tagEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
});

const popupStateSchema = z.object({
  connectionId: z.string().min(1).nullable(),
  screen: z.enum(["home", "tabs", "add-connection"]),
  selectedTabIds: z.array(z.number().int().positive()),
  draftTabIds: z.array(z.number().int().positive()),
  selectedSnapshot: z.string(),
  destination: z.enum(["session", "snapshot"]),
  advanced: z.boolean(),
  resourceName: z.string(),
  description: z.string(),
  tags: z.array(tagEntrySchema).max(100),
});

export type PopupState = z.infer<typeof popupStateSchema>;
export type PopupScreen = PopupState["screen"];
export type TeleportDestination = PopupState["destination"];

const popupStateKey = "apertureCompanionPopupState";

export async function getPopupState(): Promise<PopupState | null> {
  const stored = await chrome.storage.session.get(popupStateKey);
  const parsed = popupStateSchema.safeParse(stored[popupStateKey]);
  return parsed.success ? parsed.data : null;
}

export async function savePopupState(state: PopupState): Promise<void> {
  await chrome.storage.session.set({ [popupStateKey]: popupStateSchema.parse(state) });
}

export async function clearPopupState(): Promise<void> {
  await chrome.storage.session.remove(popupStateKey);
}
