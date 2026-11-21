import type { ProxyConfig } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { FieldError } from "@aperture-browser/ui/components/field";
import { Plus, Trash2 } from "lucide-react";
import { Choice } from "#/components/choice.tsx";
import { reveal } from "#/lib/reveal.ts";

/** A session's routing while it is edited: with rows that are not filled in yet. */
export interface ProxyDraft {
  readonly mode: "direct" | "quick" | "advanced";
  /** One proxy for everything. */
  readonly url: string;
  readonly upstreams: ReadonlyArray<{ readonly name: string; readonly url: string }>;
  readonly rules: ReadonlyArray<{
    readonly match: string;
    /** `direct`, `refuse`, `local`, an upstream's name, or a proxy's address. */
    readonly via: string;
    /** Whether `via` is a proxy's address typed in, and not one of the ways there are. */
    readonly typed?: boolean;
  }>;
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
    rules: proxy.rules.map((rule) => ({
      match: rule.match,
      via: rule.via,
      typed: !WAYS.includes(rule.via) && !(rule.via in (proxy.upstreams ?? {})),
    })),
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

/** What is wrong with a draft, for whoever fills it in; nothing where it can be kept. */
export const proxyRules = (draft: ProxyDraft) => {
  if (draft.mode === "quick") {
    return /^[a-z][a-z\d+.-]*:\/\/\S+$/iu.test(draft.url.trim())
      ? undefined
      : "Enter the proxy's address, like socks5://host:1080";
  }
  if (draft.mode === "advanced") {
    if (draft.upstreams.some((one) => (one.name.trim() === "") !== (one.url.trim() === ""))) {
      return "An upstream needs both a name and an address";
    }
    if (draft.rules.some((rule) => rule.match.trim() === "" || rule.via.trim() === "")) {
      return "A rule needs both what it matches and where that goes";
    }
    const upstreams = draft.upstreams.map((one) => one.name.trim());
    const lost = draft.rules.find(
      (rule) => rule.typed !== true && !WAYS.includes(rule.via) && !upstreams.includes(rule.via),
    );
    if (lost !== undefined) {
      return `A rule goes through ${lost.via}, which is no upstream above`;
    }
  }
  return undefined;
};

/** The ways a rule sends connections that need no upstream. */
const WAYS: ReadonlyArray<string> = ["direct", "refuse", "local"];
const TYPED = "\u0000typed";

const MODES = [
  { value: "direct", label: "Direct, from the node" },
  { value: "quick", label: "Everything through one proxy" },
  { value: "advanced", label: "By rules" },
] as const;

const replaced = <A,>(all: ReadonlyArray<A>, at: number, one: A) =>
  all.map((kept, index) => (index === at ? one : kept));
const without = <A,>(all: ReadonlyArray<A>, at: number) => all.filter((_, index) => index !== at);

type ProxyEditorProps = {
  draft: ProxyDraft;
  /** What is wrong with the draft, where it was not kept for it. */
  error?: string | undefined;
  onChange: (draft: ProxyDraft) => void;
};

/** How a session's connections are routed: direct, through one proxy, or by rules. */
export function ProxyEditor({ draft, error, onChange }: ProxyEditorProps) {
  return (
    <div data-console-proxy className="aperture:grid aperture:min-w-0 aperture:gap-3">
      <Choice
        aria-label="Routing"
        className="aperture:w-full"
        value={draft.mode}
        options={MODES}
        onChange={(mode) => onChange({ ...draft, mode })}
      />
      {draft.mode === "quick" ? (
        <Input
          name="proxy-url"
          aria-label="Proxy address"
          aria-invalid={error !== undefined}
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
                <Choice
                  aria-label="Rule route"
                  className="aperture:w-44 aperture:shrink-0"
                  value={rule.typed === true ? TYPED : rule.via}
                  options={[
                    { value: "direct", label: "Direct" },
                    { value: "refuse", label: "Refuse" },
                    { value: "local", label: "Local tunnel" },
                    ...draft.upstreams
                      .filter((one) => one.name.trim() !== "")
                      .map((one) => ({ value: one.name.trim(), label: one.name.trim() })),
                    // One that names an upstream which is gone still says which.
                    ...(rule.typed !== true &&
                    !WAYS.includes(rule.via) &&
                    !draft.upstreams.some((one) => one.name.trim() === rule.via)
                      ? [{ value: rule.via, label: `${rule.via} (missing)` }]
                      : []),
                    { value: TYPED, label: "Proxy address…" },
                  ]}
                  onChange={(via) =>
                    onChange({
                      ...draft,
                      rules: replaced(
                        draft.rules,
                        at,
                        via === TYPED
                          ? { match: rule.match, via: "", typed: true }
                          : { match: rule.match, via },
                      ),
                    })
                  }
                />
                {rule.typed === true ? (
                  <Input
                    aria-label="Proxy address"
                    placeholder="socks5://host:1080"
                    value={rule.via}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        rules: replaced(draft.rules, at, { ...rule, via: event.target.value }),
                      })
                    }
                  />
                ) : null}
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
                onChange({ ...draft, rules: [...draft.rules, { match: "", via: "direct" }] })
              }
            >
              <Plus />
              Rule
            </Button>
          </section>
        </>
      ) : null}
      <FieldError ref={reveal}>{error}</FieldError>
    </div>
  );
}
