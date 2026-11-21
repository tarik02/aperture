import * as Base64Url from "effect/encoding/Base64Url";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Guest } from "../shares/schemas.ts";

/**
 * Carries a guest's share link to its session's path, and to nowhere else: nothing is
 * done in the API, or in another session, by a page that merely has it.
 */
export const SHARE_COOKIE = "aperture_share";

/**
 * The same for the address a guest's page asks about its link at, so that the page is
 * shown again without the link being in its address.
 */
export const LINK_COOKIE = "aperture_share_link";

/** A guest as a cookie carries them: the secret, and after a dot the name, which may have any letter. */
export const carried = (guest: Guest) => `${guest.token}.${Base64Url.encode(guest.name)}`;

/** The guest a request's cookie of that name carries; nobody where it carries none. */
export const guestOf = (
  request: HttpServerRequest.HttpServerRequest,
  cookie: string,
): Option.Option<Guest> => {
  const [token = "", name = ""] = (request.cookies[cookie] ?? "").split(".");
  return token === ""
    ? Option.none()
    : Option.some({
        token,
        name: Result.getOrElse(Base64Url.decodeString(name), () => ""),
      });
};
