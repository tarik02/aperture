import { create } from "zustand";
import type { TokenRevokedFilterValue } from "#/lib/api/query-keys.ts";
import type { ApiToken } from "#/lib/api/schemas.ts";

export type TokenConfirmAction = { kind: "batch-revoke" } | { kind: "revoke"; token: ApiToken };

type TokenListPageState = {
  name: string;
  revoked: TokenRevokedFilterValue;
  authorityType: string;
  scope: string;
  selectedTokens: Record<string, ApiToken>;
  confirmAction: TokenConfirmAction | null;
  setName: (name: string) => void;
  setRevoked: (revoked: TokenRevokedFilterValue) => void;
  setAuthorityType: (authorityType: string) => void;
  setScope: (scope: string) => void;
  toggleTokenSelection: (token: ApiToken, selected: boolean) => void;
  clearSelectedTokens: () => void;
  removeSelectedToken: (tokenId: string) => void;
  setConfirmAction: (action: TokenConfirmAction | null) => void;
};

export const ALL_AUTHORITY = "__all__";
export const ALL_SCOPES = "__all__";

export const useTokenListPageStore = create<TokenListPageState>()((set) => ({
  name: "",
  revoked: "active",
  authorityType: ALL_AUTHORITY,
  scope: ALL_SCOPES,
  selectedTokens: {},
  confirmAction: null,
  setName: (name) => set({ name }),
  setRevoked: (revoked) => set({ revoked }),
  setAuthorityType: (authorityType) => set({ authorityType }),
  setScope: (scope) => set({ scope }),
  toggleTokenSelection: (token, selected) =>
    set((state) => {
      const selectedTokens = { ...state.selectedTokens };
      if (selected) {
        selectedTokens[token.id] = token;
      } else {
        delete selectedTokens[token.id];
      }
      return { selectedTokens };
    }),
  clearSelectedTokens: () => set({ selectedTokens: {} }),
  removeSelectedToken: (tokenId) =>
    set((state) => {
      const selectedTokens = { ...state.selectedTokens };
      delete selectedTokens[tokenId];
      return { selectedTokens };
    }),
  setConfirmAction: (confirmAction) => set({ confirmAction }),
}));
