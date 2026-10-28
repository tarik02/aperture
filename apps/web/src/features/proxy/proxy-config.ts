import * as Redacted from "effect/Redacted";
import type { ProxyConfig, ProxyRule, SessionProxy } from "@aperture-browser/api-client";

export type ProxyDraftUpstream = {
  id: string;
  name: string;
  url: string;
  auth: string;
  /** Loaded from a saved config whose secret is write-only and must be re-entered. */
  needsSecret: boolean;
};

export type ProxyDraftRule = {
  id: string;
  match: string;
  via: string;
};

export type ProxyDraft = {
  upstreams: ProxyDraftUpstream[];
  rules: ProxyDraftRule[];
};

export type ProxyDraftErrors = {
  upstreams: Record<string, string | undefined>;
  rules: Record<string, string | undefined>;
  form?: string;
};

export const DEFAULT_UPSTREAM_NAME = "proxy";
export const RESERVED_VIAS = ["direct", "refuse", "local"] as const;
export const MAX_PROXY_RULES = 256;

const PROXY_SCHEMES = ["http", "https", "socks", "socks5", "socks5h"];
const TUNNEL_SCHEMES = ["ws+yamux+socks5", "wss+yamux+socks5"];
const UPSTREAM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_UPSTREAMS = 32;
const HOSTNAME_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]*:[0-9a-f:.]*)$/;
// Go's url.Redacted replaces the password with this literal.
const MASKED_PASSWORD_PATTERN = /^[a-z0-9+.-]+:\/\/[^/@]*:xxxxx@/i;

export function newUpstream(partial: Partial<Omit<ProxyDraftUpstream, "id">> = {}) {
  return {
    id: crypto.randomUUID(),
    name: "",
    url: "",
    auth: "",
    needsSecret: false,
    ...partial,
  } satisfies ProxyDraftUpstream;
}

export function newRule(partial: Partial<Omit<ProxyDraftRule, "id">> = {}) {
  return { id: crypto.randomUUID(), match: "", via: "direct", ...partial } satisfies ProxyDraftRule;
}

export function emptyProxyDraft(): ProxyDraft {
  return { upstreams: [], rules: [] };
}

export function isProxyDraftEmpty(draft: ProxyDraft) {
  return draft.upstreams.length === 0 && draft.rules.length === 0;
}

function urlScheme(url: string) {
  const match = /^([a-z0-9+.-]+):\/\//i.exec(url.trim());
  return match?.[1]?.toLowerCase();
}

export function isTunnelUrl(url: string) {
  const scheme = urlScheme(url);
  return scheme !== undefined && TUNNEL_SCHEMES.includes(scheme);
}

export function isProxyUrl(url: string) {
  const scheme = urlScheme(url);
  return scheme !== undefined && PROXY_SCHEMES.includes(scheme);
}

export function hasMaskedPassword(url: string) {
  return MASKED_PASSWORD_PATTERN.test(url.trim());
}

function looksLikeUrl(value: string) {
  return value.includes("://");
}

function upstreamFromSaved(name: string, url: string): ProxyDraftUpstream {
  return newUpstream({
    name,
    url,
    needsSecret: isTunnelUrl(url) || hasMaskedPassword(url),
  });
}

function bypassRules(bypass: string | undefined) {
  if (!bypass) {
    return [];
  }
  return bypass
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => newRule({ match: entry.startsWith(".") ? `*${entry}` : entry, via: "direct" }));
}

export function draftFromSessionProxy(proxy: SessionProxy | undefined): ProxyDraft {
  if (!proxy) {
    return emptyProxyDraft();
  }
  const upstreams = Object.entries(proxy.upstreams ?? {});
  const rules = proxy.rules ?? [];
  if (upstreams.length > 0 || rules.length > 0) {
    return {
      upstreams: upstreams.map(([name, upstream]) => upstreamFromSaved(name, upstream.url)),
      rules: rules.map((rule) => newRule({ match: rule.match, via: rule.via })),
    };
  }
  if (proxy.upstream === "proxy" && proxy.url) {
    return {
      upstreams: [upstreamFromSaved(DEFAULT_UPSTREAM_NAME, proxy.url)],
      rules: [...bypassRules(proxy.bypass), newRule({ match: "*", via: DEFAULT_UPSTREAM_NAME })],
    };
  }
  if (proxy.upstream === "tunnel") {
    return {
      upstreams: [upstreamFromSaved("tunnel", proxy.tunnel?.url ?? "")],
      rules: [...bypassRules(proxy.bypass), newRule({ match: "*", via: "tunnel" })],
    };
  }
  return emptyProxyDraft();
}

export function proxyConfigFromDraft(draft: ProxyDraft): ProxyConfig {
  if (isProxyDraftEmpty(draft)) {
    return {};
  }
  const upstreams: NonNullable<ProxyConfig["upstreams"]> = Object.fromEntries(
    draft.upstreams.map((upstream) => {
      const url = upstream.url.trim();
      const auth = upstream.auth.trim();
      return [
        upstream.name.trim(),
        isTunnelUrl(url) && auth !== "" ? { url, auth: Redacted.make(auth) } : { url },
      ];
    }),
  );
  const rules: ProxyRule[] = draft.rules.map((rule) => ({
    match: rule.match.trim(),
    via: rule.via.trim(),
  }));
  return { upstreams, rules };
}

function validateProxyUrl(url: string): string | undefined {
  if (url === "") {
    return "Enter a proxy URL";
  }
  if (!isProxyUrl(url) && !isTunnelUrl(url)) {
    return "Use http, https, socks5, socks5h or a ws(s)+yamux+socks5 tunnel URL";
  }
  if (!URL.canParse(url)) {
    return "Not a valid URL";
  }
  // Non-special schemes like socks5:// may not expose hostname in every engine, so fall back to a
  // plain check of the authority.
  const authority = url.replace(/^[^:]+:\/\//, "").split(/[/?#]/)[0] ?? "";
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPart === "" || hostPart.startsWith(":")) {
    return "Add a host, like proxy.example.com:1080";
  }
  if (hasMaskedPassword(url)) {
    return "Re-enter the password; saved passwords are never shown";
  }
  return undefined;
}

// Mirrors the server's parsing: `host`, `host:port` or `[ipv6]:port`; a bare IPv6 address has
// no port.
function validateMatch(match: string): string | undefined {
  if (match === "") {
    return "Enter a host, like *.example.com or *";
  }
  let host = match;
  if (match.startsWith("[") || match.split(":").length === 2) {
    const parts = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(match);
    if (!parts) {
      return "Use host:port, or [IPv6]:port";
    }
    const port = Number(parts[3]);
    if (port < 1 || port > 65535) {
      return "Port must be between 1 and 65535";
    }
    host = parts[1] ?? parts[2] ?? "";
  }
  host = host.toLowerCase().replace(/\.$/, "");
  const name = host.replace(/^\*\./, "");
  const validWildcard = !host.includes("*") || host === "*" || !name.includes("*");
  if (
    host === "" ||
    !validWildcard ||
    (host !== "*" && !IP_PATTERN.test(name) && !HOSTNAME_PATTERN.test(name))
  ) {
    return "Use an exact host, *.suffix or *, optionally with :port";
  }
  return undefined;
}

export function validateProxyDraft(draft: ProxyDraft): ProxyDraftErrors {
  const errors: ProxyDraftErrors = { upstreams: {}, rules: {} };
  const nameCounts = new Map<string, number>();
  for (const upstream of draft.upstreams) {
    const name = upstream.name.trim();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  for (const upstream of draft.upstreams) {
    const name = upstream.name.trim();
    const url = upstream.url.trim();
    let error: string | undefined;
    if (name === "") {
      error = "Name the upstream";
    } else if (!UPSTREAM_NAME_PATTERN.test(name)) {
      error = "Names start with a letter and use lowercase letters, digits and dashes";
    } else if ((RESERVED_VIAS as readonly string[]).includes(name)) {
      error = `"${name}" is reserved; pick another name`;
    } else if ((nameCounts.get(name) ?? 0) > 1) {
      error = `Another upstream is already named "${name}"`;
    } else {
      error = validateProxyUrl(url);
    }
    if (!error && isTunnelUrl(url) && upstream.auth.trim() === "") {
      error = upstream.needsSecret
        ? "Re-enter the auth secret; saved secrets are never shown"
        : "Tunnel URLs need an auth secret";
    }
    errors.upstreams[upstream.id] = error;
  }

  const names = new Set(draft.upstreams.map((upstream) => upstream.name.trim()));
  for (const rule of draft.rules) {
    const via = rule.via.trim();
    let error = validateMatch(rule.match.trim());
    if (!error) {
      if (via === "") {
        error = "Pick where this traffic goes";
      } else if (looksLikeUrl(via)) {
        if (isTunnelUrl(via)) {
          error = "Tunnel URLs need a secret; add them as an upstream";
        } else if (hasMaskedPassword(via)) {
          error = "Re-enter the password; saved passwords are never shown";
        } else {
          error = validateProxyUrl(via);
        }
      } else if (!(RESERVED_VIAS as readonly string[]).includes(via) && !names.has(via)) {
        error = `No upstream named "${via}"`;
      }
    }
    errors.rules[rule.id] = error;
  }

  if (draft.upstreams.length > MAX_UPSTREAMS) {
    errors.form = `Too many upstreams; the limit is ${MAX_UPSTREAMS}`;
  } else if (draft.rules.length > MAX_PROXY_RULES) {
    errors.form = `Too many routes; the limit is ${MAX_PROXY_RULES}`;
  } else if (draft.upstreams.length > 0 && draft.rules.length === 0) {
    errors.form = "Add a route; without one all traffic goes direct";
  }
  return errors;
}

export function hasProxyDraftErrors(errors: ProxyDraftErrors) {
  return (
    errors.form !== undefined ||
    Object.values(errors.upstreams).some(Boolean) ||
    Object.values(errors.rules).some(Boolean)
  );
}

export function isProxyConfigured(proxy: SessionProxy | undefined) {
  return !isProxyDraftEmpty(draftFromSessionProxy(proxy));
}

function displayHost(url: string) {
  const authority = url.replace(/^[^:]+:\/\//, "").split(/[/?#]/)[0] ?? "";
  return authority.slice(authority.lastIndexOf("@") + 1) || url;
}

export function describeProxy(proxy: SessionProxy | undefined): string | null {
  const draft = draftFromSessionProxy(proxy);
  if (draft.rules.length === 0) {
    return null;
  }
  const last = draft.rules[draft.rules.length - 1];
  const onlyDirectBefore = draft.rules.slice(0, -1).every((rule) => rule.via === "direct");
  if (last && last.match === "*" && onlyDirectBefore) {
    if (last.via === "local") {
      return "via local tunnel";
    }
    if (last.via === "refuse") {
      return "blocked";
    }
    const upstream = draft.upstreams.find((item) => item.name === last.via);
    const url = upstream?.url ?? (looksLikeUrl(last.via) ? last.via : undefined);
    if (url) {
      return `via ${displayHost(url)}`;
    }
  }
  return draft.rules.length === 1 ? "1 route" : `${draft.rules.length} routes`;
}
