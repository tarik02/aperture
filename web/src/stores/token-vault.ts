import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AuthMeResponse } from "#/lib/api/schemas.ts";
import { formatRawTokenLabel, maskTokenId, parseTokenId } from "#/lib/token-id.ts";

export type AuthorityType = "system_admin" | "tenant";

export type TokenProfile = {
  id: string;
  label: string;
  rawToken: string;
  maskedTokenId: string;
  authorityType: AuthorityType | null;
  tokenName: string | null;
  tenantId: string | null;
  scopes: string[];
  selectedTenantId: string | null;
  selectedTenantDisplayName: string | null;
  lastUsedAt: number | null;
};

type TokenVaultState = {
  profiles: TokenProfile[];
  activeProfileId: string | null;
  hydrated: boolean;
  bootstrapping: boolean;
  addProfile: (input: { rawToken: string; label?: string }) => string | null;
  removeProfile: (profileId: string) => void;
  renameProfile: (profileId: string, label: string) => void;
  setActiveProfile: (profileId: string | null) => void;
  applyBootstrap: (profileId: string, response: AuthMeResponse) => void;
  clearBootstrapMetadata: (profileId: string) => void;
  setSelectedTenant: (
    profileId: string,
    tenantId: string | null,
    displayName?: string | null,
  ) => void;
  touchProfile: (profileId: string) => void;
  setHydrated: (hydrated: boolean) => void;
  setBootstrapping: (bootstrapping: boolean) => void;
};

function createProfile(rawToken: string, label?: string): TokenProfile | null {
  const trimmedToken = rawToken.trim();
  const tokenId = parseTokenId(trimmedToken);
  if (!tokenId) {
    return null;
  }

  const trimmedLabel = label?.trim();
  return {
    id: crypto.randomUUID(),
    label: trimmedLabel || formatRawTokenLabel(trimmedToken),
    rawToken: trimmedToken,
    maskedTokenId: maskTokenId(tokenId),
    authorityType: null,
    tokenName: null,
    tenantId: null,
    scopes: [],
    selectedTenantId: null,
    selectedTenantDisplayName: null,
    lastUsedAt: null,
  };
}

function pickNextActiveProfile(profiles: TokenProfile[], removedId: string): string | null {
  if (profiles.length === 0) {
    return null;
  }

  const remaining = profiles.filter((profile) => profile.id !== removedId);
  return remaining[0]?.id ?? null;
}

export const useTokenVaultStore = create<TokenVaultState>()(
  persist(
    (set, get) => ({
      profiles: [],
      activeProfileId: null,
      hydrated: false,
      bootstrapping: false,

      addProfile: ({ rawToken, label }) => {
        const profile = createProfile(rawToken, label);
        if (!profile) {
          return null;
        }

        set((state) => ({
          profiles: [...state.profiles, profile],
          activeProfileId: profile.id,
        }));

        return profile.id;
      },

      removeProfile: (profileId) => {
        set((state) => {
          const profiles = state.profiles.filter((profile) => profile.id !== profileId);
          const activeProfileId =
            state.activeProfileId === profileId
              ? pickNextActiveProfile(state.profiles, profileId)
              : state.activeProfileId;

          return { profiles, activeProfileId };
        });
      },

      renameProfile: (profileId, label) => {
        const trimmedLabel = label.trim();
        if (!trimmedLabel) {
          return;
        }

        set((state) => ({
          profiles: state.profiles.map((profile) =>
            profile.id === profileId ? { ...profile, label: trimmedLabel } : profile,
          ),
        }));
      },

      setActiveProfile: (profileId) => {
        if (profileId === null) {
          set({ activeProfileId: null });
          return;
        }

        const exists = get().profiles.some((profile) => profile.id === profileId);
        if (!exists) {
          return;
        }

        set({ activeProfileId: profileId });
      },

      applyBootstrap: (profileId, response) => {
        const now = Date.now();
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (profile.id !== profileId) {
              return profile;
            }

            const { principal, selectedTenant } = response;
            const isTenantToken = principal.authorityType === "tenant";

            return {
              ...profile,
              maskedTokenId: maskTokenId(principal.tokenId),
              authorityType: principal.authorityType,
              tokenName: principal.name,
              tenantId: principal.tenantId,
              scopes: principal.scopes,
              selectedTenantId: isTenantToken
                ? principal.tenantId
                : (selectedTenant?.id ?? profile.selectedTenantId),
              selectedTenantDisplayName: isTenantToken
                ? null
                : (selectedTenant?.displayName ?? profile.selectedTenantDisplayName),
              lastUsedAt: now,
            };
          }),
        }));
      },

      clearBootstrapMetadata: (profileId) => {
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (profile.id !== profileId) {
              return profile;
            }

            return {
              ...profile,
              authorityType: null,
              tokenName: null,
              tenantId: null,
              scopes: [],
              selectedTenantId: null,
              selectedTenantDisplayName: null,
            };
          }),
          activeProfileId: state.activeProfileId === profileId ? null : state.activeProfileId,
        }));
      },

      setSelectedTenant: (profileId, tenantId, displayName = null) => {
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (profile.id !== profileId || profile.authorityType !== "system_admin") {
              return profile;
            }

            return {
              ...profile,
              selectedTenantId: tenantId,
              selectedTenantDisplayName: displayName,
            };
          }),
        }));
      },

      touchProfile: (profileId) => {
        const now = Date.now();
        set((state) => ({
          profiles: state.profiles.map((profile) =>
            profile.id === profileId ? { ...profile, lastUsedAt: now } : profile,
          ),
        }));
      },

      setHydrated: (hydrated) => set({ hydrated }),
      setBootstrapping: (bootstrapping) => set({ bootstrapping }),
    }),
    {
      name: "aperture-token-vault",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        profiles: state.profiles,
        activeProfileId: state.activeProfileId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    },
  ),
);

export function selectActiveProfile(state: TokenVaultState): TokenProfile | null {
  if (!state.activeProfileId) {
    return null;
  }

  return state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
}

export function isSystemAdminProfile(profile: TokenProfile | null): boolean {
  return profile?.authorityType === "system_admin";
}

export function profileDisplayName(profile: TokenProfile): string {
  return profile.tokenName ? `${profile.label} (${profile.tokenName})` : profile.label;
}
