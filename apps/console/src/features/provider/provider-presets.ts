import * as Schema from "effect/Schema";

/**
 * Something a provider's addresses are made of that is another's for each who uses it:
 * a tenant, a domain, a realm. It is typed, and put into the addresses where they name it.
 */
const Part = Schema.Struct({
  /** What the addresses name it by, between braces. */
  name: Schema.String,
  label: Schema.String,
  placeholder: Schema.String,
  /** An address, which is taken without what ends it, or a word, which is taken as typed. */
  kind: Schema.Literals(["address", "word"]),
  /** What a word is held to, and what is said of one that is not that. */
  pattern: Schema.optional(Schema.String),
  says: Schema.optional(Schema.String),
});
export type Part = typeof Part.Type;

/**
 * What is known of a provider before anyone says anything of theirs: what its addresses
 * are made of, what is asked of it, and where a client is registered with it. An address
 * names a part as `{name}`, and the client's id as `{clientId}`.
 */
const Preset = Schema.Struct({
  id: Schema.String,
  /** What it is called, and what a provider made from it is called and known by at first. */
  name: Schema.String,
  providerId: Schema.String,
  /**
   * What it speaks: OpenID Connect, and says at its issuer how it is reached, or OAuth 2.0
   * alone, and is asked where it is said to be.
   */
  kind: Schema.Literals(["oidc", "oauth2"]),
  parts: Schema.Array(Part),
  /**
   * Its issuer, made of its parts. Without, the issuer is typed: it is the address of
   * whoever runs the provider, and `issuerAt` is what one looks like or most often is.
   */
  issuer: Schema.optional(Schema.String),
  issuerAt: Schema.optional(
    Schema.Struct({ placeholder: Schema.String, first: Schema.optional(Schema.String) }),
  ),
  /**
   * Where one that speaks OAuth 2.0 alone is asked, where that is the same for everyone
   * who uses it. Without, each place is typed.
   */
  endpoints: Schema.optional(
    Schema.Struct({
      authorization: Schema.String,
      token: Schema.String,
      userInfo: Schema.String,
      emails: Schema.optional(Schema.String),
    }),
  ),
  /** What is asked of it where nothing else is said, and what else it is known to give. */
  scopes: Schema.Array(Schema.String),
  offers: Schema.Array(Schema.String),
  /** Whether anyone at all has an account there: making people of all of them is told of. */
  open: Schema.Boolean,
  /** Where a client is registered with it, or where it says how. */
  register: Schema.optional(Schema.String),
  /** What whoever adds it has to know, and would not think to look for. */
  note: Schema.optional(Schema.String),
});
export type Preset = typeof Preset.Type;

/** The scopes every provider is asked for where nothing else is said. */
export const SCOPES = ["openid", "email", "profile"] as const;
/** The scopes that are offered for every provider, whether or not it says it gives them. */
export const COMMON_SCOPES = [...SCOPES, "offline_access", "groups"] as const;

const HOST = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$";
const SLUG = "^[A-Za-z0-9._-]+$";

export const CUSTOM = "custom";

/** What a provider that is not among those known is added as, by what it speaks. */
export const CUSTOM_OF = { oidc: CUSTOM, oauth2: "custom-oauth2" } as const;

/**
 * The providers that are known. Adding one is adding it here: the form reads what it
 * shows and what it fills in from this, and nothing of any provider is said elsewhere.
 * Each address is as the provider's own discovery document or documentation has it.
 */
export const PRESETS: ReadonlyArray<Preset> = Schema.decodeUnknownSync(Schema.Array(Preset))([
  {
    id: "auth0",
    name: "Auth0",
    providerId: "auth0",
    kind: "oidc",
    parts: [
      {
        name: "domain",
        label: "Domain",
        placeholder: "example.us.auth0.com",
        kind: "word",
        pattern: HOST,
        says: "A domain such as example.us.auth0.com.",
      },
    ],
    issuer: "https://{domain}",
    scopes: SCOPES,
    offers: ["offline_access"],
    open: false,
    register: "https://manage.auth0.com/#/applications",
  },
  {
    id: "authelia",
    name: "Authelia",
    providerId: "authelia",
    kind: "oidc",
    parts: [],
    issuerAt: { placeholder: "https://auth.example.com" },
    scopes: SCOPES,
    offers: ["offline_access", "groups"],
    open: false,
    register: "https://www.authelia.com/configuration/identity-providers/openid-connect/clients/",
  },
  {
    id: "authentik",
    name: "authentik",
    providerId: "authentik",
    kind: "oidc",
    parts: [
      {
        name: "base",
        label: "authentik URL",
        placeholder: "https://authentik.example.com",
        kind: "address",
      },
      {
        name: "slug",
        label: "Application slug",
        placeholder: "aperture",
        kind: "word",
        pattern: SLUG,
        says: "The slug of the application, as its address has it.",
      },
    ],
    issuer: "{base}/application/o/{slug}/",
    scopes: SCOPES,
    offers: ["offline_access"],
    open: false,
    register:
      "https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider/",
    note: "Since 2025.10 authentik says an address is verified only where its email scope mapping is changed to.",
  },
  {
    id: "dex",
    name: "Dex",
    providerId: "dex",
    kind: "oidc",
    parts: [],
    issuerAt: { placeholder: "https://dex.example.com/dex" },
    scopes: SCOPES,
    offers: ["offline_access", "groups"],
    open: false,
    register: "https://dexidp.io/docs/guides/using-dex/",
  },
  {
    id: "github",
    name: "GitHub",
    providerId: "github",
    kind: "oauth2",
    parts: [],
    endpoints: {
      authorization: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      userInfo: "https://api.github.com/user",
      emails: "https://api.github.com/user/emails",
    },
    scopes: ["read:user", "user:email"],
    offers: [],
    open: true,
    register: "https://github.com/settings/developers",
  },
  {
    id: "gitlab",
    name: "GitLab",
    providerId: "gitlab",
    kind: "oidc",
    parts: [],
    issuerAt: { placeholder: "https://gitlab.example.com", first: "https://gitlab.com" },
    scopes: SCOPES,
    offers: [],
    open: true,
    register: "https://docs.gitlab.com/integration/oauth_provider/",
  },
  {
    id: "google",
    name: "Google",
    providerId: "google",
    kind: "oidc",
    parts: [],
    issuer: "https://accounts.google.com",
    scopes: SCOPES,
    offers: [],
    open: true,
    register: "https://console.cloud.google.com/auth/clients",
  },
  {
    id: "kanidm",
    name: "Kanidm",
    providerId: "kanidm",
    kind: "oidc",
    parts: [
      {
        name: "base",
        label: "Kanidm URL",
        placeholder: "https://idm.example.com",
        kind: "address",
      },
    ],
    issuer: "{base}/oauth2/openid/{clientId}",
    scopes: SCOPES,
    offers: ["groups"],
    open: false,
    register: "https://kanidm.github.io/kanidm/stable/integrations/oauth2.html",
  },
  {
    id: "keycloak",
    name: "Keycloak",
    providerId: "keycloak",
    kind: "oidc",
    parts: [
      {
        name: "base",
        label: "Keycloak URL",
        placeholder: "https://keycloak.example.com",
        kind: "address",
      },
      {
        name: "realm",
        label: "Realm",
        placeholder: "master",
        kind: "word",
        pattern: SLUG,
        says: "The realm's name, as its address has it.",
      },
    ],
    issuer: "{base}/realms/{realm}",
    scopes: SCOPES,
    offers: ["offline_access"],
    open: false,
    register: "https://www.keycloak.org/docs/latest/server_admin/index.html#_oidc_clients",
  },
  {
    id: "entra",
    name: "Microsoft Entra ID",
    providerId: "microsoft",
    kind: "oidc",
    parts: [
      {
        name: "tenant",
        label: "Tenant ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
        kind: "word",
        pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$",
        says: "The directory's ID, which is five groups of letters and digits.",
      },
    ],
    issuer: "https://login.microsoftonline.com/{tenant}/v2.0",
    scopes: SCOPES,
    offers: ["offline_access"],
    open: false,
    register:
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    note: "Entra ID does not say whether an address is verified, and nobody signs in on an address that is not.",
  },
  {
    id: "okta",
    name: "Okta",
    providerId: "okta",
    kind: "oidc",
    parts: [
      {
        name: "domain",
        label: "Domain",
        placeholder: "example.okta.com",
        kind: "word",
        pattern: HOST,
        says: "A domain such as example.okta.com.",
      },
    ],
    issuer: "https://{domain}",
    scopes: SCOPES,
    offers: ["offline_access", "groups"],
    open: false,
    register:
      "https://help.okta.com/en-us/content/topics/apps/apps_app_integration_wizard_oidc.htm",
  },
  {
    id: "pocket-id",
    name: "Pocket ID",
    providerId: "pocket-id",
    kind: "oidc",
    parts: [],
    issuerAt: { placeholder: "https://id.example.com" },
    scopes: SCOPES,
    offers: ["groups"],
    open: false,
    register: "https://pocket-id.org/docs",
  },
  {
    id: "zitadel",
    name: "Zitadel",
    providerId: "zitadel",
    kind: "oidc",
    parts: [],
    issuerAt: { placeholder: "https://example.zitadel.cloud" },
    scopes: SCOPES,
    offers: ["offline_access"],
    open: false,
    register: "https://zitadel.com/docs/guides/manage/console/applications",
  },
  {
    id: CUSTOM,
    name: "Custom OpenID Connect",
    providerId: "",
    kind: "oidc",
    parts: [],
    issuerAt: { placeholder: "https://id.example.com" },
    scopes: SCOPES,
    offers: [],
    open: false,
  },
  {
    id: "custom-oauth2",
    name: "Custom OAuth 2.0",
    providerId: "",
    kind: "oauth2",
    parts: [],
    scopes: [],
    offers: [],
    open: false,
  },
]);

/** The preset known by an id, which is one of theirs. */
export const presetOf = (id: string): Preset => {
  const found =
    PRESETS.find((preset) => preset.id === id) ?? PRESETS.find((preset) => preset.id === CUSTOM);
  if (found === undefined) {
    throw new Error("no providers are known");
  }
  return found;
};

/**
 * Which provider's mark one made from it is shown with: its own, by its id, and none for
 * one that is typed whole.
 */
export const iconOf = (preset: Preset) => (preset.providerId === "" ? null : preset.id);

/** What was typed for a part, as an address names it. */
const taken = (part: Part, typed: string) =>
  part.kind === "address" ? typed.trim().replace(/\/+$/u, "") : typed.trim();

/**
 * An address of a preset with what was typed put into it, or nothing while any of what it
 * names is yet to be typed.
 */
export const addressOf = (
  preset: Preset,
  address: string,
  typed: Readonly<Record<string, string>>,
  clientId: string,
) => {
  const said: Record<string, string> = { clientId: clientId.trim() };
  for (const part of preset.parts) {
    said[part.name] = taken(part, typed[part.name] ?? "");
  }
  const names = [...address.matchAll(/\{(\w+)\}/gu)].map(([, name]) => name ?? "");
  return names.every((name) => (said[name] ?? "") !== "")
    ? address.replaceAll(/\{(\w+)\}/gu, (_, name: string) => said[name] ?? "")
    : "";
};

/** What a preset's rules say of what was typed for one of its parts. */
export const partRule =
  (part: Part) =>
  ({ value }: { value: string }) => {
    const typed = value.trim();
    if (typed === "") {
      return `${part.label} is required.`;
    }
    if (part.kind === "address") {
      return URL.canParse(typed) ? undefined : "Enter its address.";
    }
    return part.pattern === undefined || new RegExp(part.pattern, "u").test(typed)
      ? undefined
      : (part.says ?? `${part.label} is not written so.`);
  };
