import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { EmailTaken, PersonNotFound } from "../errors.ts";

/** Someone who signs in: known by an email address, and proven by what they sign in with. */
export interface Person {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Who people are and how they prove it: signing in and out, passwords, and whose a
 * browser's cookies are. What signs people in is behind this, and nothing else knows it.
 */
export interface IdentityShape {
  /** Where its own routes are, which a browser asks to sign in and out. */
  readonly path: `/${string}`;
  /**
   * Answers a request to its own routes. `from` is where the request came from, by which
   * tries at signing in are counted; nobody's count without.
   */
  readonly handle: (request: Request, from: Option.Option<string>) => Effect.Effect<Response>;
  /** Whose the cookies of a request are; nobody's where they sign nobody in. */
  readonly personOf: (headers: Headers) => Effect.Effect<Option.Option<Person>>;
  /** Makes a person, who signs in once they set a password with a setup token. */
  readonly create: (person: {
    readonly email: string;
    readonly name: string;
  }) => Effect.Effect<Person, EmailTaken>;
  /** A token with which a person sets a password of their own: a first one, or another. */
  readonly setupToken: (email: string) => Effect.Effect<string, PersonNotFound>;
  /**
   * Turns a person's second factor off without them: for one who lost what gives its codes.
   * Their password stays, and they turn a second factor on again themselves.
   */
  readonly resetSecondFactor: (email: string) => Effect.Effect<void, PersonNotFound>;
}

export class Identity extends Context.Service<Identity, IdentityShape>()(
  "@aperture-browser/control/Identity",
) {}
