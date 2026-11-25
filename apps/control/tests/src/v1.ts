/**
 * Credentials as Aperture v1 kept them, made by the libraries v1 made them with
 * (`alexedwards/argon2id` with v1's parameters, and `x/crypto/bcrypt` at its default cost),
 * with what they are of.
 */

/** Longer than better-auth takes by itself: v1 took passwords of up to 1024 characters. */
export const V1_PASSWORD = "a password of v1, longer than v2 takes by itself; ".repeat(4);
export const V1_PASSWORD_DIGEST =
  "$argon2id$v=19$m=65536,t=3,p=2$r+3GGlFfA77ae4oVsMBmqQ$KavHIyjeLR0RpEoW/mU6NljpSpDJE70syJ93MawANJ4";

/** What follows a token's id in a token of v1, with underscores, as base64url has. */
export const V1_TOKEN_SECRET = "secret-of-ci-kept-from-v1_with_underscores";
export const V1_TOKEN_DIGEST = "$2a$10$m0iJ0HozvY2rXs3ItvRzy.i7gFtYUG3Z0AYpQ.lsabxXNtsyvKP0i";

/** An authenticator's secret, as v1 kept it: base32, with no padding. */
export const V1_SECOND_FACTOR = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
