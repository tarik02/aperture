import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Option } from "effect/Option";
import type {
  ProviderConfigured,
  ProviderInvalid,
  ProviderNotFound,
  ProviderTaken,
} from "../errors.ts";
import type { Endpoints, Kind } from "./schemas.ts";

/** A provider as an admin is told of it: never its client secret. */
export interface ToldProvider {
  readonly id: string;
  readonly name: string;
  /** Which provider's mark it is shown with; none said, for one the settings name. */
  readonly icon: string | null;
  readonly kind: Kind;
  /** Nothing, for one that speaks OAuth 2.0 alone: it has `endpoints` in its place. */
  readonly issuer: string;
  readonly endpoints: Endpoints | null;
  readonly clientId: string;
  readonly secretSet: boolean;
  readonly scopes: ReadonlyArray<string>;
  readonly provision: boolean;
  readonly domains: ReadonlyArray<string>;
  readonly enabled: boolean;
  /** Kept here, or named by the settings: the second is changed there alone. */
  readonly source: "stored" | "configuration";
  readonly createdAt: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc | null;
}

/**
 * A provider people sign in through now, with all that signing in through it takes: where
 * it says how it is reached, or where it is asked, by what it speaks.
 */
export type ActiveProvider = ActiveAs &
  (
    | { readonly kind: "oidc"; readonly discoveryUrl: string }
    | { readonly kind: "oauth2"; readonly endpoints: Endpoints }
  );

interface ActiveAs {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly scopes: ReadonlyArray<string>;
  /** Whether someone it vouches for, whom no admin made a person, is made one. */
  readonly provision: boolean;
  /** The domains of the addresses people are made for so; any address where none is named. */
  readonly domains: ReadonlyArray<string>;
  /** Whether an admin added it: its own word for where it is reached is held to more then. */
  readonly stored: boolean;
}

/** Where a provider that speaks OAuth 2.0 alone is asked, as an admin says it. */
export interface GivenEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly userInfo: string;
  readonly emails?: string | null | undefined;
}

export interface GivenProvider {
  readonly id: string;
  readonly name: string;
  /** Which provider's mark it is shown with; none, where it is not said or said to be none. */
  readonly icon?: string | null | undefined;
  /** OpenID Connect, where it is not said. It stays what it was first said to be. */
  readonly kind?: Kind | undefined;
  /** Of one that speaks OpenID Connect. */
  readonly issuer?: string | undefined;
  /** Of one that speaks OAuth 2.0 alone. */
  readonly endpoints?: GivenEndpoints | undefined;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes?: ReadonlyArray<string> | undefined;
  readonly provision?: boolean | undefined;
  readonly domains?: ReadonlyArray<string> | undefined;
  readonly enabled?: boolean | undefined;
}

/** What is said anew of a provider. An empty secret is none: the one it has stays. */
export type ChangedProvider = Partial<Omit<GivenProvider, "id" | "kind">>;

/** What is asked how it is reached: an issuer, or where a provider without one is asked. */
export type Asked = { readonly issuer: string } | { readonly endpoints: GivenEndpoints };

/**
 * Who a provider that speaks OAuth 2.0 alone says someone is: what it knows them by, and
 * the address that is theirs, with whether the provider itself says it verified it.
 */
export interface Vouched {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
}

/** What came of asking a provider how it is reached. */
export interface Checked {
  readonly ok: boolean;
  /** What is wrong, each a sentence. */
  readonly problems: ReadonlyArray<string>;
  /** The scopes it says it gives, where it is reached and says any. */
  readonly scopes: ReadonlyArray<string>;
}

/**
 * The providers people sign in through: those the settings name, which are as they are
 * for as long as the program runs, and those an admin adds, changes and removes meanwhile.
 * Removing one removes nobody; whoever came through it alone waits for it to be back.
 */
export interface ProvidersShape {
  /** All of them, those of the settings first. */
  readonly list: () => Effect.Effect<ReadonlyArray<ToldProvider>>;
  /**
   * Adds a provider. One that is to sign people in at once is asked how it is reached
   * first, and refused where that fails; one that is added disabled is kept as it is said.
   */
  readonly create: (
    given: GivenProvider,
  ) => Effect.Effect<ToldProvider, ProviderTaken | ProviderInvalid>;
  /** Changes a provider an admin added, and holds it to what adding one is held to. */
  readonly change: (
    id: string,
    changed: ChangedProvider,
  ) => Effect.Effect<ToldProvider, ProviderNotFound | ProviderConfigured | ProviderInvalid>;
  readonly remove: (id: string) => Effect.Effect<void, ProviderNotFound | ProviderConfigured>;
  /**
   * Asks a provider how it is reached, and says what is wrong with the answer. One that
   * speaks OAuth 2.0 alone says of itself nowhere how it is: each place it is asked at is
   * asked as nobody, and has to answer as that place does.
   */
  readonly check: (asked: Asked) => Effect.Effect<Checked>;
  /**
   * Who a provider that speaks OAuth 2.0 alone says the holder of a token of its own is;
   * nobody, where it does not say, or says it of no address.
   */
  readonly vouched: (endpoints: Endpoints, accessToken: string) => Effect.Effect<Option<Vouched>>;
  /**
   * Those people sign in through now. Where the settings and an admin know two by one id,
   * the settings' is the one.
   */
  readonly active: () => Effect.Effect<ReadonlyArray<ActiveProvider>>;
  /** Another number than it gave before, once any provider was changed by any program. */
  readonly revision: () => Effect.Effect<number>;
}

export class Providers extends Context.Service<Providers, ProvidersShape>()(
  "@aperture-browser/control/Providers",
) {}
