import type { ProxyConfig } from "@aperture-browser/control-api";

/** An upstream while it is edited: a row that may not be filled in yet. */
export interface ProxyDraftUpstream {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** The secret a tunnel is dialed with; a proxy's credentials are in its URL. */
  readonly auth: string;
}

/** A route while it is edited. */
export interface ProxyDraftRule {
  readonly id: string;
  readonly match: string;
  /** `direct`, `refuse`, `local`, an upstream's name, or a proxy's URL. */
  readonly via: string;
  /** What the editor shows no field for, kept as it was. */
  readonly to?: string | undefined;
  readonly tls?: boolean | undefined;
}

/** A session's proxy while it is edited. */
export interface ProxyDraft {
  readonly upstreams: ReadonlyArray<ProxyDraftUpstream>;
  readonly rules: ReadonlyArray<ProxyDraftRule>;
}

/** What is wrong with a draft, said at the row it is wrong in. */
export interface ProxyDraftErrors {
  readonly upstreams: Readonly<Record<string, string | undefined>>;
  readonly rules: Readonly<Record<string, string | undefined>>;
  readonly form?: string | undefined;
}

/** What the one proxy of the field at the top is called among the upstreams. */
export const DEFAULT_UPSTREAM_NAME = "proxy";
/** The ways a route sends connections that need no upstream. */
export const RESERVED_VIAS: ReadonlyArray<string> = ["direct", "refuse", "local"];

const PROXY_SCHEMES = ["http", "https", "socks", "socks5", "socks5h"];
const TUNNEL_SCHEMES = ["ws+yamux+socks5", "wss+yamux+socks5"];
const UPSTREAM_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/u;
const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]*:[0-9a-f:.]*)$/u;
const MOST_UPSTREAMS = 32;
const MOST_RULES = 256;

export const newUpstream = (
  partial: Partial<Omit<ProxyDraftUpstream, "id">> = {},
): ProxyDraftUpstream => ({ id: crypto.randomUUID(), name: "", url: "", auth: "", ...partial });

export const newRule = (partial: Partial<Omit<ProxyDraftRule, "id">> = {}): ProxyDraftRule => ({
  id: crypto.randomUUID(),
  match: "",
  via: "direct",
  ...partial,
});

export const emptyDraft: ProxyDraft = { upstreams: [], rules: [] };

export const isDraftEmpty = (draft: ProxyDraft) =>
  draft.upstreams.length === 0 && draft.rules.length === 0;

const schemeOf = (url: string) => /^([a-z0-9+.-]+):\/\//iu.exec(url.trim())?.[1]?.toLowerCase();

export const isTunnelUrl = (url: string) => TUNNEL_SCHEMES.includes(schemeOf(url) ?? "");
const isProxyUrl = (url: string) => PROXY_SCHEMES.includes(schemeOf(url) ?? "");

/**
 * The draft a proxy is edited from. Everything through one proxy that is named by its URL
 * alone is shown as the proxy of the field at the top, which is how the editor makes one.
 */
export const draftOf = (proxy: ProxyConfig | null): ProxyDraft => {
  if (proxy === null) {
    return emptyDraft;
  }
  const upstreams = Object.entries(proxy.upstreams ?? {});
  const [only] = proxy.rules;
  if (
    upstreams.length === 0 &&
    proxy.rules.length === 1 &&
    only?.match === "*" &&
    only.via.includes("://") &&
    only.to === undefined &&
    only.tls === undefined
  ) {
    return {
      upstreams: [newUpstream({ name: DEFAULT_UPSTREAM_NAME, url: only.via })],
      rules: [newRule({ match: "*", via: DEFAULT_UPSTREAM_NAME })],
    };
  }
  return {
    upstreams: upstreams.map(([name, upstream]) =>
      newUpstream({ name, url: upstream.url, auth: upstream.auth ?? "" }),
    ),
    rules: proxy.rules.map((rule) => newRule(rule)),
  };
};

/** The proxy a draft comes to; none where nothing is set, and everything goes direct. */
export const proxyOf = (draft: ProxyDraft): ProxyConfig | null => {
  if (isDraftEmpty(draft)) {
    return null;
  }
  return {
    upstreams: Object.fromEntries(
      draft.upstreams.map((upstream) => {
        const url = upstream.url.trim();
        const auth = upstream.auth.trim();
        return [upstream.name.trim(), isTunnelUrl(url) && auth !== "" ? { url, auth } : { url }];
      }),
    ),
    rules: draft.rules.map((rule) => ({
      match: rule.match.trim(),
      via: rule.via.trim(),
      ...(rule.to === undefined ? {} : { to: rule.to }),
      ...(rule.tls === undefined ? {} : { tls: rule.tls }),
    })),
  };
};

const urlRule = (url: string) => {
  if (url === "") {
    return "Enter a proxy URL";
  }
  if (!isProxyUrl(url) && !isTunnelUrl(url)) {
    return "Use http, https, socks5, socks5h or a ws(s)+yamux+socks5 tunnel URL";
  }
  if (!URL.canParse(url)) {
    return "Not a valid URL";
  }
  // A scheme the browser does not know has no host of its own in every engine.
  const authority = url.replace(/^[^:]+:\/\//u, "").split(/[/?#]/u)[0] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return host === "" || host.startsWith(":")
    ? "Add a host, like proxy.example.com:1080"
    : undefined;
};

/** As the session reads it: `host`, `host:port` or `[ipv6]:port`. */
const matchRule = (match: string) => {
  if (match === "") {
    return "Enter a host, like *.example.com or *";
  }
  let host = match;
  if (match.startsWith("[") || match.split(":").length === 2) {
    const parts = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(match);
    if (parts === null) {
      return "Use host:port, or [IPv6]:port";
    }
    const port = Number(parts[3]);
    if (port < 1 || port > 65535) {
      return "Port must be between 1 and 65535";
    }
    host = parts[1] ?? parts[2] ?? "";
  }
  host = host.toLowerCase().replace(/\.$/u, "");
  const name = host.replace(/^\*\./u, "");
  const wildcard = !host.includes("*") || host === "*" || !name.includes("*");
  return host === "" || !wildcard || (host !== "*" && !IP.test(name) && !HOSTNAME.test(name))
    ? "Use an exact host, *.suffix or *, optionally with :port"
    : undefined;
};

/** What is wrong with a draft, row by row; nothing where it can be kept. */
export const proxyRules = (draft: ProxyDraft): ProxyDraftErrors | undefined => {
  const named = new Map<string, number>();
  for (const upstream of draft.upstreams) {
    named.set(upstream.name.trim(), (named.get(upstream.name.trim()) ?? 0) + 1);
  }
  const upstreams = Object.fromEntries(
    draft.upstreams.map((upstream) => {
      const name = upstream.name.trim();
      const url = upstream.url.trim();
      const wrong =
        name === ""
          ? "Name the upstream"
          : !UPSTREAM_NAME.test(name)
            ? "Names start with a letter and use lowercase letters, digits and dashes"
            : RESERVED_VIAS.includes(name)
              ? `"${name}" is reserved; pick another name`
              : (named.get(name) ?? 0) > 1
                ? `Another upstream is already named "${name}"`
                : (urlRule(url) ??
                  (isTunnelUrl(url) && upstream.auth.trim() === ""
                    ? "Tunnel URLs need an auth secret"
                    : undefined));
      return [upstream.id, wrong];
    }),
  );
  const rules = Object.fromEntries(
    draft.rules.map((rule) => {
      const via = rule.via.trim();
      const wrong =
        matchRule(rule.match.trim()) ??
        (via === ""
          ? "Pick where this traffic goes"
          : via.includes("://")
            ? isTunnelUrl(via)
              ? "Tunnel URLs need a secret; add them as an upstream"
              : urlRule(via)
            : !RESERVED_VIAS.includes(via) && !named.has(via)
              ? `No upstream named "${via}"`
              : undefined);
      return [rule.id, wrong];
    }),
  );
  const form =
    draft.upstreams.length > MOST_UPSTREAMS
      ? `Too many upstreams; the limit is ${MOST_UPSTREAMS}`
      : draft.rules.length > MOST_RULES
        ? `Too many routes; the limit is ${MOST_RULES}`
        : draft.upstreams.length > 0 && draft.rules.length === 0
          ? "Add a route; without one all traffic goes direct"
          : undefined;
  const wrong =
    form !== undefined ||
    Object.values(upstreams).some((one) => one !== undefined) ||
    Object.values(rules).some((one) => one !== undefined);
  return wrong ? { upstreams, rules, form } : undefined;
};
