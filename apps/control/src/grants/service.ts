import type { Caller, Scope, TokenResources } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  ClientInvalid,
  Forbidden,
  GrantNotFound,
  GrantRefused,
  OAuthClientNotFound,
  RedirectRefused,
} from "../errors.ts";
import type { Client, Grant, Tokens } from "./schemas.ts";

/** What an app asks a person for: itself, and where the answer is to go. */
export interface Asked {
  readonly clientId: string;
  readonly redirectUri: string;
}

/**
 * Grants: what people give apps that ask to act as their account, as OAuth has it. An
 * app registers itself, a person who is signed in decides what it gets, and the app
 * exchanges the code it is sent for tokens, which are whose the grant is as an API
 * token is.
 */
export interface GrantsShape {
  /** Takes an app's word for what it is called and where it is sent answers. */
  readonly register: (app: {
    readonly name: string | undefined;
    readonly redirectUris: ReadonlyArray<string>;
  }) => Effect.Effect<Client, ClientInvalid>;
  /** The app that asks, where it registered and may be answered there. */
  readonly asking: (asked: Asked) => Effect.Effect<Client, OAuthClientNotFound | RedirectRefused>;
  /**
   * Gives the app a grant of the caller's account, in place of any it had, and a code to
   * exchange for the grant's tokens. A caller gives nothing that is more than its own.
   */
  readonly approve: (
    caller: Caller,
    asked: Asked & {
      /** What the app proves itself by when it exchanges the code. */
      readonly codeChallenge: string;
      readonly scopes: ReadonlyArray<Scope>;
      readonly resources: TokenResources | undefined;
    },
  ) => Effect.Effect<string, Forbidden | OAuthClientNotFound | RedirectRefused>;
  /** Exchanges a code for tokens: once, by the app it was made for, which proves itself. */
  readonly exchange: (
    asked: Asked & { readonly code: string; readonly codeVerifier: string },
  ) => Effect.Effect<Tokens, GrantRefused>;
  /** Exchanges a refresh token for new tokens; the one given is good no more. */
  readonly refresh: (asked: {
    readonly clientId: string;
    readonly refreshToken: string;
  }) => Effect.Effect<Tokens, GrantRefused>;
  /**
   * An app gives back the grant one of its tokens is of, access or refresh: the grant is
   * gone as when the person takes it back, with every token of it, so that nothing the
   * app left lying about is good for anything. A token that is none is given back too.
   */
  readonly giveBack: (given: {
    readonly token: string;
    /** The app that gives it back, where it says: it gives back no other's. */
    readonly clientId: string | undefined;
  }) => Effect.Effect<void, GrantRefused>;
  /**
   * Forgets what is good for nothing: the apps that registered a while ago and were never
   * given a grant, and the codes and tokens that ran out.
   */
  readonly forget: () => Effect.Effect<void>;
  /** The grants of the caller's own account. */
  readonly list: (caller: Caller) => Effect.Effect<ReadonlyArray<Grant>, Forbidden>;
  /** Takes a grant back, and every token of it with it. */
  readonly revoke: (caller: Caller, id: string) => Effect.Effect<void, GrantNotFound>;
}

export class Grants extends Context.Service<Grants, GrantsShape>()(
  "@aperture-browser/control/Grants",
) {}
