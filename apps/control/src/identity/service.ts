import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { AccountInvalid, EmailTaken, PersonNotFound } from "../errors.ts";

/**
 * Someone who signs in: known by an email address, and proven by what they sign in with,
 * which is a password of their own, a passkey, or the word of a provider.
 */
export interface Person {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** What a person signs in with. */
export interface SignInMethods {
  /** Whether they have a password: one they set, since nobody is given one. */
  readonly password: boolean;
  readonly secondFactor: boolean;
  readonly passkeys: number;
  /** The providers they came through, by what each is called. */
  readonly providers: ReadonlyArray<string>;
}

/**
 * Who people are and how they prove it: signing in and out, passwords, passkeys, and whose
 * a browser's cookies are. What signs people in is behind this, and nothing else knows it.
 */
export interface IdentityShape {
  /** Where its own routes are, which a browser asks to sign in and out. */
  readonly path: `/${string}`;
  /** The providers people sign in through, by what each is known as. */
  readonly providers: () => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly name: string; readonly icon: string | null }>
  >;
  /**
   * Answers a request to its own routes. `from` is where the request came from, by which
   * tries at signing in are counted; nobody's count without.
   */
  readonly handle: (request: Request, from: Option.Option<string>) => Effect.Effect<Response>;
  /** Whose the cookies of a request are; nobody's where they sign nobody in. */
  readonly personOf: (headers: Headers) => Effect.Effect<Option.Option<Person>>;
  /**
   * Makes a person, who has nothing to sign in with until they set a password with a
   * setup token, or a provider vouches for their address; or who has the password that is
   * given, where they named it themselves.
   */
  readonly create: (person: {
    readonly email: string;
    readonly name: string;
    readonly password?: string | undefined;
  }) => Effect.Effect<Person, EmailTaken | AccountInvalid>;
  /** What each person signs in with, by their email address. */
  readonly methods: () => Effect.Effect<ReadonlyMap<string, SignInMethods>>;
  /**
   * Signs a person out of every browser at once. Whether they sign in again is not said
   * here: no one whose account is disabled does.
   */
  readonly signOut: (email: string) => Effect.Effect<void, PersonNotFound>;
  /** Removes a person with all they signed in with; their address is anyone's again. */
  readonly remove: (email: string) => Effect.Effect<void, PersonNotFound>;
  /** A token with which a person sets a password of their own: a first one, or another. */
  readonly setupToken: (email: string) => Effect.Effect<string, PersonNotFound>;
  /**
   * Turns a person's second factor off without them: for one who lost what gives its codes.
   * Their password stays, and they turn a second factor on again themselves.
   */
  readonly resetSecondFactor: (email: string) => Effect.Effect<void, PersonNotFound>;
  /**
   * Removes a person's passkeys without them: for one who lost what holds them, or whose
   * device another has. What else they sign in with stays.
   */
  readonly removePasskeys: (email: string) => Effect.Effect<void, PersonNotFound>;
}

export class Identity extends Context.Service<Identity, IdentityShape>()(
  "@aperture-browser/control/Identity",
) {}
