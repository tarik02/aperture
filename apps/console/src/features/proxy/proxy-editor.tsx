import type { ProxyConfig } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@aperture-browser/ui/components/native-select";
import { Plus, Trash2 } from "lucide-react";

/** A session's routing while it is edited: with rows that are not filled in yet. */
export interface ProxyDraft {
  readonly mode: "direct" | "quick" | "advanced";
  /** One proxy for everything. */
  readonly url: string;
  readonly upstreams: ReadonlyArray<{ readonly name: string; readonly url: string }>;
  readonly rules: ReadonlyArray<{ readonly match: string; readonly via: string }>;
}

export const emptyDraft: ProxyDraft = { mode: "direct", url: "", upstreams: [], rules: [] };

/** The draft a routing is edited from; one proxy for everything is shown as just that. */
export const draftOf = (proxy: ProxyConfig | null): ProxyDraft => {
  if (proxy === null || proxy.rules.length === 0) {
    return emptyDraft;
  }
  const upstreams = Object.entries(proxy.upstreams ?? {}).map(([name, upstream]) => ({
    name,
    url: upstream.url,
  }));
  const [only] = proxy.rules;
  if (
    proxy.rules.length === 1 &&
    upstreams.length === 0 &&
    only?.match === "*" &&
    only.via.includes("://")
  ) {
    return { ...emptyDraft, mode: "quick", url: only.via };
  }
  return {
    mode: "advanced",
    url: "",
    upstreams,
    rules: proxy.rules.map((rule) => ({ match: rule.match, via: rule.via })),
  };
};

/** The routing a draft comes to; none where everything goes direct. Rows left empty are dropped. */
export const proxyOf = (draft: ProxyDraft): ProxyConfig | null => {
  if (draft.mode === "quick") {
    return draft.url.trim() === "" ? null : { rules: [{ match: "*", via: draft.url.trim() }] };
  }
  if (draft.mode === "advanced") {
    const rules = draft.rules
      .map((rule) => ({ match: rule.match.trim(), via: rule.via.trim() }))
      .filter((rule) => rule.match !== "" && rule.via !== "");
    const upstreams = Object.fromEntries(
      draft.upstreams
        .filter((upstream) => upstream.name.trim() !== "" && upstream.url.trim() !== "")
        .map((upstream) => [upstream.name.trim(), { url: upstream.url.trim() }]),
    );
    return rules.length === 0 ? null : { upstreams, rules };
  }
  return null;
};

const replaced = <A,>(all: ReadonlyArray<A>, at: number, one: A) =>
  all.map((kept, index) => (index === at ? one : kept));
const without = <A,>(all: ReadonlyArray<A>, at: number) => all.filter((_, index) => index !== at);

type ProxyEditorProps = {
  draft: ProxyDraft;
  onChange: (draft: ProxyDraft) => void;
};

/** How a session's connections are routed: direct, through one proxy, or by rules. */
export function ProxyEditor({ draft, onChange }: ProxyEditorProps) {
  return (
    <div data-console-proxy className="aperture:grid aperture:gap-3">
      <NativeSelect
        aria-label="Routing"
        value={draft.mode}
        onChange={(event) => onChange({ ...draft, mode: event.target.value as ProxyDraft["mode"] })}
      >
        <NativeSelectOption value="direct">Direct, from the node</NativeSelectOption>
        <NativeSelectOption value="quick">Everything through one proxy</NativeSelectOption>
        <NativeSelectOption value="advanced">By rules</NativeSelectOption>
      </NativeSelect>
      {draft.mode === "quick" ? (
        <Input
          name="proxy-url"
          placeholder="socks5://user:password@host:1080"
          value={draft.url}
          onChange={(event) => onChange({ ...draft, url: event.target.value })}
        />
      ) : null}
      {draft.mode === "advanced" ? (
        <>
          <section className="aperture:grid aperture:gap-2">
            <h3 className="aperture:text-xs aperture:font-medium aperture:text-muted-foreground">
              Upstreams
            </h3>
            {draft.upstreams.map((upstream, at) => (
              <div key={at} className="aperture:flex aperture:gap-2">
                <Input
                  aria-label="Upstream name"
                  placeholder="name"
                  className="aperture:w-32"
                  value={upstream.name}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      upstreams: replaced(draft.upstreams, at, {
                        ...upstream,
                        name: event.target.value,
                      }),
                    })
                  }
                />
                <Input
                  aria-label="Upstream URL"
                  placeholder="socks5://host:1080"
                  value={upstream.url}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      upstreams: replaced(draft.upstreams, at, {
                        ...upstream,
                        url: event.target.value,
                      }),
                    })
                  }
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove upstream"
                  onClick={() => onChange({ ...draft, upstreams: without(draft.upstreams, at) })}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="aperture:justify-self-start"
              onClick={() =>
                onChange({ ...draft, upstreams: [...draft.upstreams, { name: "", url: "" }] })
              }
            >
              <Plus />
              Upstream
            </Button>
          </section>
          <section className="aperture:grid aperture:gap-2">
            <h3 className="aperture:text-xs aperture:font-medium aperture:text-muted-foreground">
              Rules, the first that matches decides
            </h3>
            {draft.rules.map((rule, at) => (
              <div key={at} className="aperture:flex aperture:gap-2">
                <Input
                  aria-label="Rule match"
                  placeholder="*.example.com"
                  value={rule.match}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      rules: replaced(draft.rules, at, { ...rule, match: event.target.value }),
                    })
                  }
                />
                <Input
                  aria-label="Rule route"
                  placeholder="direct, refuse, local or an upstream"
                  value={rule.via}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      rules: replaced(draft.rules, at, { ...rule, via: event.target.value }),
                    })
                  }
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove rule"
                  onClick={() => onChange({ ...draft, rules: without(draft.rules, at) })}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="aperture:justify-self-start"
              onClick={() =>
                onChange({ ...draft, rules: [...draft.rules, { match: "", via: "" }] })
              }
            >
              <Plus />
              Rule
            </Button>
          </section>
        </>
      ) : null}
    </div>
  );
}
