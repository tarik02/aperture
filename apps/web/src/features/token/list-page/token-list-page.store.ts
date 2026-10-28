import { create } from "zustand";
import type { TokenRevokedFilterValue } from "#/lib/api/query-keys.ts";
import type { ApiToken } from "@aperture-browser/api-client";

export type TokenConfirmAction = { kind: "batch-revoke" } | { kind: "revoke"; token: ApiToken };

type TokenListPageState = {
  name: string;
  revoked: TokenRevokedFilterValue;
  authorityType: string;
  scope: string;
  confirmAction: TokenConfirmAction | null;
  setName: (name: string) => void;
  setRevoked: (revoked: TokenRevokedFilterValue) => void;
  setAuthorityType: (authorityType: string) => void;
  setScope: (scope: string) => void;
  setConfirmAction: (action: TokenConfirmAction | null) => void;
};

export const ALL_AUTHORITY = "__all__";
export const ALL_SCOPES = "__all__";

export const useTokenListPageStore = create<TokenListPageState>()((set) => ({
  name: "",
  revoked: "active",
  authorityType: ALL_AUTHORITY,
  scope: ALL_SCOPES,
  confirmAction: null,
  setName: (name) => set({ name }),
  setRevoked: (revoked) => set({ revoked }),
  setAuthorityType: (authorityType) => set({ authorityType }),
  setScope: (scope) => set({ scope }),
  setConfirmAction: (confirmAction) => set({ confirmAction }),
}));
