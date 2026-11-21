import * as UrlPath from "@aperture-browser/shared/url-path";
export interface Address {
  /** The session's base, e.g. `http://host:7900/` or `http://host:7900/sessions/<id>`. */
  readonly url: string;
  readonly token?: string | undefined;
  /** The operator's display name. */
  readonly name?: string | undefined;
}

const based = (address: Address, path: string) => {
  const origin: string | undefined = globalThis.location?.href;
  const base = new URL(address.url, origin);
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}${path}`;
  return base;
};

/** A route below the session's base, for a request that carries the token in a header. */
export const route = (address: Address, path: string) => based(address, path).toString();

/**
 * A route below the session's base that carries the token itself, for what cannot send a
 * header: a link, a picture, the session socket.
 */
export const authenticated = (address: Address, path: string) => {
  const url = based(address, path);
  if (address.token !== undefined) {
    url.searchParams.set("token", address.token);
  }
  return url;
};

export const socketUrl = (address: Address) => {
  const url = authenticated(address, "/ws");
  if (address.name !== undefined && address.name !== "") {
    url.searchParams.set("name", address.name);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export const fileUrl = (address: Address, path: string) =>
  authenticated(
    address,
    UrlPath.make`/files/${UrlPath.segments(path.replace(/^\/+/u, ""))}`,
  ).toString();

export const screenshotUrl = (address: Address, tab: number, width?: number) => {
  const url = authenticated(address, UrlPath.make`/targets/${tab}/screenshot.png`);
  if (width !== undefined) {
    url.searchParams.set("width", String(Math.round(width)));
  }
  return url.toString();
};

export const headers = (address: Address): Record<string, string> =>
  address.token === undefined ? {} : { Authorization: `Bearer ${address.token}` };
