import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AuthMeResponse, ResourceGrant, ResourceMode } from "#/lib/api/schemas.ts";
import { maskTokenId, parseTokenId } from "#/lib/token-id.ts";

export type AuthorityType = "system_admin" | "tenant";

type ProfileMetadata = {
  id: string;
  authorityType: AuthorityType | null;
  tokenName: string | null;
  tenantId: string | null;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  selectedTenantId: string | null;
  selectedTenantDisplayName: string | null;
  availableTenants: AuthMeResponse["availableTenants"];
  lastUsedAt: number | null;
};

export type TokenProfile =
  | (ProfileMetadata & {
      credentialType: "api_token";
      rawToken: string;
      maskedTokenId: string;
    })
  | (ProfileMetadata & {
      credentialType: "web_session";
    });

type TokenVaultState = {
  profiles: TokenProfile[];
  activeProfileId: string | null;
  hydrated: boolean;
  bootstrapping: boolean;
  addProfile: (input: { rawToken: string }) => string | null;
  upsertWebSession: (response: AuthMeResponse) => string;
  removeProfile: (profileId: string) => void;
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

function createProfile(rawToken: string): TokenProfile | null {
  const trimmedToken = rawToken.trim();
  const tokenId = parseTokenId(trimmedToken);
  if (!tokenId) {
    return null;
  }

  return {
    id: tokenId,
    credentialType: "api_token",
    rawToken: trimmedToken,
    maskedTokenId: maskTokenId(tokenId),
    authorityType: null,
    tokenName: null,
    tenantId: null,
    scopes: [],
    resourceMode: "all",
    resourceGrants: [],
    selectedTenantId: null,
    selectedTenantDisplayName: null,
    availableTenants: [],
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

      addProfile: ({ rawToken }) => {
        const profile = createProfile(rawToken);
        if (!profile) {
          return null;
        }

        set((state) => ({
          profiles: state.profiles.some((entry) => entry.id === profile.id)
            ? state.profiles
            : [...state.profiles, profile],
          activeProfileId: profile.id,
        }));

        return profile.id;
      },

      upsertWebSession: (response) => {
        const id = `web:${response.principal.id}`;
        set((state) => {
          const existing = state.profiles.find((profile) => profile.id === id);
          const existingTenant = response.availableTenants.find(
            (tenant) => tenant.id === existing?.selectedTenantId,
          );
          const selectedTenant = response.selectedTenant ?? existingTenant ?? null;
          const profile: TokenProfile = {
            id,
            credentialType: "web_session",
            authorityType: response.principal.authorityType,
            tokenName: response.principal.name,
            tenantId: response.principal.tenantId,
            scopes: response.principal.scopes,
            resourceMode: response.principal.resourceMode,
            resourceGrants: response.principal.resourceGrants,
            selectedTenantId: selectedTenant?.id ?? null,
            selectedTenantDisplayName: selectedTenant?.displayName ?? null,
            availableTenants: response.availableTenants,
            lastUsedAt: Date.now(),
          };
          const activeProfile = state.profiles.find((entry) => entry.id === state.activeProfileId);
          const tokenProfiles = state.profiles.filter(
            (entry) => entry.credentialType === "api_token",
          );

          return {
            profiles: [...tokenProfiles, profile],
            activeProfileId:
              !activeProfile || activeProfile.credentialType === "web_session"
                ? id
                : state.activeProfileId,
          };
        });
        return id;
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
            const isTenantToken =
              principal.authorityType === "tenant" && profile.credentialType === "api_token";

            return {
              ...profile,
              ...(profile.credentialType === "api_token" && principal.tokenId
                ? { maskedTokenId: maskTokenId(principal.tokenId) }
                : {}),
              authorityType: principal.authorityType,
              tokenName: principal.name,
              tenantId: principal.tenantId,
              scopes: principal.scopes,
              resourceMode: principal.resourceMode,
              resourceGrants: principal.resourceGrants,
              selectedTenantId: isTenantToken
                ? principal.tenantId
                : (selectedTenant?.id ?? profile.selectedTenantId),
              selectedTenantDisplayName: isTenantToken
                ? null
                : (selectedTenant?.displayName ?? profile.selectedTenantDisplayName),
              availableTenants: response.availableTenants,
              lastUsedAt: now,
            };
          }),
        }));
      },

      clearBootstrapMetadata: (profileId) => {
        set((state) => ({
          profiles: state.profiles.flatMap((profile) => {
            if (profile.id !== profileId) {
              return [profile];
            }
            if (profile.credentialType === "web_session") {
              return [];
            }

            return [
              {
                ...profile,
                authorityType: null,
                tokenName: null,
                tenantId: null,
                scopes: [],
                resourceMode: "all",
                resourceGrants: [],
                selectedTenantId: null,
                selectedTenantDisplayName: null,
                availableTenants: [],
              },
            ];
          }),
          activeProfileId:
            state.activeProfileId === profileId
              ? pickNextActiveProfile(state.profiles, profileId)
              : state.activeProfileId,
        }));
      },

      setSelectedTenant: (profileId, tenantId, displayName = null) => {
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (
              profile.id !== profileId ||
              (profile.authorityType !== "system_admin" && profile.credentialType !== "web_session")
            ) {
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
  if (profile.credentialType === "web_session") {
    return profile.tokenName ?? "Account session";
  }
  return profile.tokenName
    ? `${profile.tokenName} · ${profile.maskedTokenId}`
    : profile.maskedTokenId;
}
