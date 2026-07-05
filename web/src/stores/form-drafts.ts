import { create } from "zustand";
import type { CreateTokenResponse } from "#/lib/api/schemas.ts";

export type DraftTagEntry = {
  key: string;
  value: string;
};

type TokenFormDraft = {
  rawToken: string;
  tokenError: string | null;
  submitting: boolean;
};

type CreateTenantDraft = {
  displayName: string;
  error: string | null;
};

type EditTenantDraft = {
  tenantId: string | null;
  displayName: string;
  error: string | null;
};

type CreateTokenDraft = {
  name: string;
  authorityType: "system_admin" | "tenant";
  tenantId: string;
  scopes: string[];
  expiresAt: string;
  nameError: string | null;
  scopeError: string | null;
  createdToken: CreateTokenResponse | null;
};

type CreateSessionDraft = {
  channel: string;
  baseSnapshot: string | null;
  browserArgs: string[];
  tagEntries: DraftTagEntry[];
  channelError: string | null;
};

type PromoteSessionDraft = {
  name: string;
  force: boolean;
  tagEntries: DraftTagEntry[];
  nameError: string | null;
};

type EditTagsDraft = {
  resourceKey: string | null;
  entries: DraftTagEntry[];
  submitting: boolean;
};

type FormDraftState = {
  tokenForm: TokenFormDraft;
  createTenant: CreateTenantDraft;
  editTenant: EditTenantDraft;
  createToken: CreateTokenDraft;
  createSession: CreateSessionDraft;
  promoteSession: PromoteSessionDraft;
  editTags: EditTagsDraft;
  setTokenForm: (patch: Partial<TokenFormDraft>) => void;
  resetTokenForm: () => void;
  setCreateTenant: (patch: Partial<CreateTenantDraft>) => void;
  resetCreateTenant: () => void;
  setEditTenant: (patch: Partial<EditTenantDraft>) => void;
  resetEditTenant: (tenantId: string | null, displayName: string) => void;
  setCreateToken: (patch: Partial<CreateTokenDraft>) => void;
  resetCreateToken: (tenantId: string) => void;
  toggleCreateTokenScope: (scope: string) => void;
  setCreateSession: (patch: Partial<CreateSessionDraft>) => void;
  resetCreateSession: () => void;
  setPromoteSession: (patch: Partial<PromoteSessionDraft>) => void;
  resetPromoteSession: () => void;
  setEditTags: (patch: Partial<EditTagsDraft>) => void;
  resetEditTags: (resourceKey: string, entries: DraftTagEntry[]) => void;
};

const defaultTokenForm: TokenFormDraft = {
  rawToken: "",
  tokenError: null,
  submitting: false,
};

const defaultCreateTenant: CreateTenantDraft = {
  displayName: "",
  error: null,
};

const defaultCreateToken = (tenantId: string): CreateTokenDraft => ({
  name: "",
  authorityType: "tenant",
  tenantId,
  scopes: ["sessions:read", "sessions:write"],
  expiresAt: "",
  nameError: null,
  scopeError: null,
  createdToken: null,
});

const defaultCreateSession: CreateSessionDraft = {
  channel: "",
  baseSnapshot: null,
  browserArgs: [],
  tagEntries: [],
  channelError: null,
};

const defaultPromoteSession: PromoteSessionDraft = {
  name: "",
  force: false,
  tagEntries: [],
  nameError: null,
};

export const useFormDraftStore = create<FormDraftState>()((set) => ({
  tokenForm: defaultTokenForm,
  createTenant: defaultCreateTenant,
  editTenant: {
    tenantId: null,
    displayName: "",
    error: null,
  },
  createToken: defaultCreateToken(""),
  createSession: defaultCreateSession,
  promoteSession: defaultPromoteSession,
  editTags: {
    resourceKey: null,
    entries: [],
    submitting: false,
  },
  setTokenForm: (patch) => set((state) => ({ tokenForm: { ...state.tokenForm, ...patch } })),
  resetTokenForm: () => set({ tokenForm: defaultTokenForm }),
  setCreateTenant: (patch) =>
    set((state) => ({ createTenant: { ...state.createTenant, ...patch } })),
  resetCreateTenant: () => set({ createTenant: defaultCreateTenant }),
  setEditTenant: (patch) => set((state) => ({ editTenant: { ...state.editTenant, ...patch } })),
  resetEditTenant: (tenantId, displayName) =>
    set({ editTenant: { tenantId, displayName, error: null } }),
  setCreateToken: (patch) => set((state) => ({ createToken: { ...state.createToken, ...patch } })),
  resetCreateToken: (tenantId) => set({ createToken: defaultCreateToken(tenantId) }),
  toggleCreateTokenScope: (scope) =>
    set((state) => ({
      createToken: {
        ...state.createToken,
        scopes: state.createToken.scopes.includes(scope)
          ? state.createToken.scopes.filter((item) => item !== scope)
          : [...state.createToken.scopes, scope],
      },
    })),
  setCreateSession: (patch) =>
    set((state) => ({ createSession: { ...state.createSession, ...patch } })),
  resetCreateSession: () => set({ createSession: defaultCreateSession }),
  setPromoteSession: (patch) =>
    set((state) => ({ promoteSession: { ...state.promoteSession, ...patch } })),
  resetPromoteSession: () => set({ promoteSession: defaultPromoteSession }),
  setEditTags: (patch) => set((state) => ({ editTags: { ...state.editTags, ...patch } })),
  resetEditTags: (resourceKey, entries) =>
    set({ editTags: { resourceKey, entries, submitting: false } }),
}));
