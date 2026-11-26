import type { SettingEntry, SettingKey, SettingView } from "@aperture-browser/control-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LEVEL_WORDS } from "#/features/settings/setting-words.ts";
import { call, type Client, isFailure, told } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** Where settings are said: the instance, a workspace, the account in one or in none, a session. */
export type SettingsTarget =
  | { readonly level: "instance" }
  | { readonly level: "workspace"; readonly id: string }
  | { readonly level: "account"; readonly workspaceId: string | null }
  | { readonly level: "session"; readonly id: string };

const keyOf = (target: SettingsTarget) =>
  target.level === "instance"
    ? queryKeys.settings("instance", "")
    : target.level === "account"
      ? queryKeys.settings("account", target.workspaceId ?? "")
      : queryKeys.settings(target.level, target.id);

const read = (target: SettingsTarget) => (api: Client) => {
  switch (target.level) {
    case "instance":
      return api.settings.instance();
    case "workspace":
      return api.settings.workspace({ params: { id: target.id } });
    case "account":
      return api.settings.account({
        query: target.workspaceId === null ? {} : { workspaceId: target.workspaceId },
      });
    case "session":
      return api.settings.session({ params: { id: target.id } });
  }
};

const write = (target: SettingsTarget, key: SettingKey, entry: SettingEntry) => (api: Client) => {
  switch (target.level) {
    case "instance":
      return api.settings.setInstance({ params: { key }, payload: entry });
    case "workspace":
      return api.settings.setWorkspace({ params: { id: target.id, key }, payload: entry });
    case "account":
      return api.settings.setAccount({
        params: { key },
        query: target.workspaceId === null ? {} : { workspaceId: target.workspaceId },
        payload: entry,
      });
    case "session":
      return api.settings.setSession({ params: { id: target.id, key }, payload: entry });
  }
};

const clear = (target: SettingsTarget, key: SettingKey) => (api: Client) => {
  switch (target.level) {
    case "instance":
      return api.settings.clearInstance({ params: { key } });
    case "workspace":
      return api.settings.clearWorkspace({ params: { id: target.id, key } });
    case "account":
      return api.settings.clearAccount({
        params: { key },
        query: target.workspaceId === null ? {} : { workspaceId: target.workspaceId },
      });
    case "session":
      return api.settings.clearSession({ params: { id: target.id, key } });
  }
};

export type { SettingView };

export function useSettingsQuery(target: SettingsTarget, enabled = true) {
  return useQuery({
    queryKey: keyOf(target),
    queryFn: (): Promise<ReadonlyArray<SettingView>> =>
      call(read(target)).then((answer) => answer.settings),
    enabled,
  });
}

/** What a refusal of a setting says, on the row of the setting. */
const refusal = (error: unknown) => {
  if (isFailure(error) && error._tag === "SettingOutOfBounds" && "level" in error) {
    const level = LEVEL_WORDS[error.level as keyof typeof LEVEL_WORDS] ?? "level above";
    return `The ${level} does not let it be that.`;
  }
  if (isFailure(error) && error._tag === "SettingInvalid") {
    return error.message ?? told(error);
  }
  return told(error);
};

/** What is said of each setting that changed: an entry, or nothing to say it no more. */
export type SettingChange = { readonly key: SettingKey; readonly entry: SettingEntry | null };

/**
 * Says all the changes at once. Each is said or refused alone: what was refused comes back,
 * by setting, with why, once what was said is read again.
 */
export function useSaveSettingsMutation(target: SettingsTarget) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (
      said: ReadonlyArray<SettingChange>,
    ): Promise<Partial<Record<SettingKey, string>>> => {
      const results = await Promise.allSettled(
        said.map(({ key, entry }) =>
          entry === null ? call(clear(target, key)) : call(write(target, key, entry)),
        ),
      );
      // Whatever a setting comes to below a level may change with it: every answer is stale.
      await queries.invalidateQueries({ queryKey: queryKeys.settingsAll });
      return Object.fromEntries(
        said.flatMap(({ key }, at) => {
          const result = results[at];
          return result?.status === "rejected" ? [[key, refusal(result.reason)]] : [];
        }),
      );
    },
    onError: (error) => toastMutationError(error, "The settings were not saved"),
  });
}
