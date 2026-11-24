import { Button } from "@aperture-browser/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import { ArrowDown, ArrowRight, ArrowUp, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  DEFAULT_UPSTREAM_NAME,
  isDraftEmpty,
  isTunnelUrl,
  newRule,
  newUpstream,
  type ProxyDraft,
  type ProxyDraftErrors,
  type ProxyDraftRule,
  type ProxyDraftUpstream,
} from "#/features/proxy/proxy-config.ts";
import { reveal } from "#/lib/reveal.ts";

type ProxyEditorProps = {
  draft: ProxyDraft;
  onChange: (draft: ProxyDraft) => void;
  /** What is wrong with the draft, where it was not kept for it. */
  errors?: ProxyDraftErrors | undefined;
  disabled?: boolean;
};

const BUILTIN_VIAS = [
  { value: "direct", label: "Direct" },
  { value: "refuse", label: "Block" },
  { value: "local", label: "Local tunnel" },
];

/** Whether a draft is what the field at the top makes by itself: one proxy for everything. */
const isAutoShape = (draft: ProxyDraft) => {
  const [rule] = draft.rules;
  return (
    draft.upstreams.length === 1 &&
    draft.rules.length === 1 &&
    rule?.match.trim() === "*" &&
    rule.via === DEFAULT_UPSTREAM_NAME
  );
};

/** Where a route is put so that it is asked before the one that takes everything. */
const catchAllIndex = (rules: ReadonlyArray<ProxyDraftRule>) => {
  const index = rules.findIndex((rule) => rule.match.trim() === "*");
  return index === -1 ? rules.length : index;
};

/**
 * How a session's connections are routed: a proxy for everything in the field at the top,
 * the routes that say which connection goes where, and, for whoever needs more than one
 * proxy, the other upstreams routes can name.
 */
export function ProxyEditor({ draft, onChange, errors, disabled = false }: ProxyEditorProps) {
  const primary = draft.upstreams.find((upstream) => upstream.name === DEFAULT_UPSTREAM_NAME);
  const others = draft.upstreams.filter((upstream) => upstream !== primary);
  const showQuickField = primary !== undefined || draft.upstreams.length === 0;
  const [advancedOpen, setAdvancedOpen] = useState(others.length > 0);
  const upstreamsVisible = advancedOpen || others.length > 0 || !showQuickField;
  const defaultVia = draft.upstreams[0]?.name.trim() || "direct";

  const setUpstreams = (upstreams: ReadonlyArray<ProxyDraftUpstream>, rules = draft.rules) =>
    onChange({ upstreams, rules });
  const setRules = (rules: ReadonlyArray<ProxyDraftRule>) =>
    onChange({ upstreams: draft.upstreams, rules });

  const updateUpstream = (id: string, patch: Partial<ProxyDraftUpstream>) => {
    const current = draft.upstreams.find((upstream) => upstream.id === id);
    if (current === undefined) {
      return;
    }
    let rules = draft.rules;
    const next = patch.name;
    if (next !== undefined && next !== current.name) {
      const shared = draft.upstreams.some((one) => one.id !== id && one.name === current.name);
      // Routes keep pointing at the upstream while it is named anew.
      if (current.name !== "" && !shared) {
        rules = rules.map((rule) => (rule.via === current.name ? { ...rule, via: next } : rule));
      }
    }
    setUpstreams(
      draft.upstreams.map((upstream) =>
        upstream.id === id ? { ...upstream, ...patch } : upstream,
      ),
      rules,
    );
  };

  const setQuickUrl = (url: string) => {
    if (primary !== undefined) {
      if (url === "" && isAutoShape(draft)) {
        onChange({ upstreams: [], rules: [] });
        return;
      }
      if (url === "" && !draft.rules.some((rule) => rule.via === DEFAULT_UPSTREAM_NAME)) {
        setUpstreams(draft.upstreams.filter((upstream) => upstream.id !== primary.id));
        return;
      }
      updateUpstream(primary.id, { url });
      return;
    }
    if (url === "") {
      return;
    }
    const upstream = newUpstream({ name: DEFAULT_UPSTREAM_NAME, url });
    if (isDraftEmpty(draft)) {
      onChange({
        upstreams: [upstream],
        rules: [newRule({ match: "*", via: DEFAULT_UPSTREAM_NAME })],
      });
      return;
    }
    setUpstreams([...draft.upstreams, upstream]);
  };

  const moveRule = (index: number, offset: number) => {
    const target = index + offset;
    const rule = draft.rules[index];
    if (target < 0 || target >= draft.rules.length || rule === undefined) {
      return;
    }
    const rules = draft.rules.filter((_, at) => at !== index);
    setRules([...rules.slice(0, target), rule, ...rules.slice(target)]);
  };

  const insertRule = (index: number, rule: ProxyDraftRule) =>
    setRules([...draft.rules.slice(0, index), rule, ...draft.rules.slice(index)]);

  const addEverythingViaProxy = () => {
    const via = draft.upstreams[0]?.name.trim() || DEFAULT_UPSTREAM_NAME;
    const rule = newRule({ match: "*", via });
    if (draft.upstreams.length === 0) {
      onChange({
        upstreams: [newUpstream({ name: DEFAULT_UPSTREAM_NAME })],
        rules: [...draft.rules, rule],
      });
      return;
    }
    setRules([...draft.rules, rule]);
  };

  const hasCatchAll = draft.rules.some((rule) => rule.match.trim() === "*");
  const upstreamNames = [
    ...new Set(draft.upstreams.map((upstream) => upstream.name.trim()).filter(Boolean)),
  ];

  return (
    <FieldGroup data-console-proxy className="aperture:min-w-0 aperture:gap-5">
      {showQuickField ? (
        <QuickProxyField
          upstream={primary}
          error={primary === undefined ? undefined : errors?.upstreams[primary.id]}
          disabled={disabled}
          onUrlChange={setQuickUrl}
          onAuthChange={(auth) =>
            primary === undefined ? undefined : updateUpstream(primary.id, { auth })
          }
        />
      ) : null}

      <FieldSet className="aperture:gap-3">
        <div className="aperture:flex aperture:flex-wrap aperture:items-end aperture:justify-between aperture:gap-2">
          <div className="aperture:flex aperture:flex-col aperture:gap-1">
            <FieldLegend variant="label" className="aperture:mb-0">
              Routes
            </FieldLegend>
            <FieldDescription>
              Checked top to bottom; the first match wins. Unmatched traffic goes direct.
            </FieldDescription>
          </div>
          <div className="aperture:flex aperture:flex-wrap aperture:gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-console-proxy-everything
              onClick={addEverythingViaProxy}
              disabled={disabled || hasCatchAll}
            >
              Everything via proxy
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-console-proxy-exception
              onClick={() => insertRule(0, newRule({ via: "direct" }))}
              disabled={disabled}
            >
              Add direct exception
            </Button>
          </div>
        </div>

        {draft.rules.length === 0 ? (
          <p className="aperture:rounded-lg aperture:border aperture:border-dashed aperture:px-3 aperture:py-2 aperture:text-sm aperture:text-muted-foreground">
            No routes. All traffic goes direct.
          </p>
        ) : (
          <ol data-console-proxy-routes className="aperture:flex aperture:flex-col aperture:gap-2">
            {draft.rules.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={index}
                count={draft.rules.length}
                upstreamNames={upstreamNames}
                error={errors?.rules[rule.id]}
                disabled={disabled}
                onChange={(patch) =>
                  setRules(
                    draft.rules.map((one) => (one.id === rule.id ? { ...one, ...patch } : one)),
                  )
                }
                onMove={(offset) => moveRule(index, offset)}
                onRemove={() => setRules(draft.rules.filter((one) => one.id !== rule.id))}
              />
            ))}
          </ol>
        )}

        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-console-proxy-route-add
            onClick={() => insertRule(catchAllIndex(draft.rules), newRule({ via: defaultVia }))}
            disabled={disabled}
          >
            <Plus />
            Add route
          </Button>
        </div>
      </FieldSet>

      {upstreamsVisible ? (
        <FieldSet className="aperture:gap-3">
          <div className="aperture:flex aperture:flex-col aperture:gap-1">
            <FieldLegend variant="label" className="aperture:mb-0">
              {showQuickField ? "More upstreams" : "Upstreams"}
            </FieldLegend>
            <FieldDescription>
              Named proxies or tunnels that routes can send traffic through.
            </FieldDescription>
          </div>
          {others.length > 0 ? (
            <ul
              data-console-proxy-upstreams
              className="aperture:flex aperture:flex-col aperture:gap-2"
            >
              {others.map((upstream) => (
                <UpstreamRow
                  key={upstream.id}
                  upstream={upstream}
                  error={errors?.upstreams[upstream.id]}
                  disabled={disabled}
                  onChange={(patch) => updateUpstream(upstream.id, patch)}
                  onRemove={() =>
                    setUpstreams(draft.upstreams.filter((one) => one.id !== upstream.id))
                  }
                />
              ))}
            </ul>
          ) : null}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-console-proxy-upstream-add
              onClick={() => setUpstreams([...draft.upstreams, newUpstream()])}
              disabled={disabled}
            >
              <Plus />
              Add upstream
            </Button>
          </div>
        </FieldSet>
      ) : (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-console-proxy-advanced
            className="aperture:text-muted-foreground"
            onClick={() => setAdvancedOpen(true)}
            disabled={disabled}
          >
            <ChevronRight />
            Advanced: more upstreams
          </Button>
        </div>
      )}

      {errors?.form === undefined ? null : <FieldError ref={reveal}>{errors.form}</FieldError>}
    </FieldGroup>
  );
}

function QuickProxyField({
  upstream,
  error,
  disabled,
  onUrlChange,
  onAuthChange,
}: {
  upstream: ProxyDraftUpstream | undefined;
  error: string | undefined;
  disabled: boolean;
  onUrlChange: (url: string) => void;
  onAuthChange: (auth: string) => void;
}) {
  const id = useId();
  const url = upstream?.url ?? "";

  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>Proxy URL</FieldLabel>
      <Input
        id={id}
        name="proxy-url"
        value={url}
        onChange={(event) => onUrlChange(event.target.value)}
        placeholder="socks5://user:pass@proxy.example.com:1080"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={error !== undefined}
        disabled={disabled}
      />
      {isTunnelUrl(url) && upstream !== undefined ? (
        <Input
          type="password"
          value={upstream.auth}
          onChange={(event) => onAuthChange(event.target.value)}
          placeholder="Auth secret"
          aria-label="Auth secret"
          autoComplete="new-password"
          disabled={disabled}
        />
      ) : null}
      {/* What is wrong with it is said where the hint was: nothing below it moves. */}
      {error === undefined ? (
        <FieldDescription>
          http, https, socks5 or socks5h. Leave empty to connect directly.
        </FieldDescription>
      ) : (
        <FieldError ref={reveal}>{error}</FieldError>
      )}
    </Field>
  );
}

function RuleRow({
  rule,
  index,
  count,
  upstreamNames,
  error,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  rule: ProxyDraftRule;
  index: number;
  count: number;
  upstreamNames: ReadonlyArray<string>;
  error: string | undefined;
  disabled: boolean;
  onChange: (patch: Partial<ProxyDraftRule>) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
}) {
  const known = new Set([...upstreamNames, ...BUILTIN_VIAS.map((item) => item.value)]);
  const builtin = [
    ...BUILTIN_VIAS,
    // One that names what is no upstream, or a proxy by its URL, still says which.
    ...(rule.via !== "" && !known.has(rule.via) ? [{ value: rule.via, label: rule.via }] : []),
  ];

  return (
    <li data-console-proxy-route className="aperture:flex aperture:flex-col aperture:gap-1">
      {/* On a phone the host has a line of its own, and where it goes the next. */}
      <div className="aperture:flex aperture:items-center aperture:gap-1.5 aperture:max-sm:flex-wrap">
        <span className="aperture:w-5 aperture:shrink-0 aperture:text-right aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums">
          {index + 1}
        </span>
        <Input
          value={rule.match}
          onChange={(event) => onChange({ match: event.target.value })}
          placeholder="*.example.com"
          aria-label={`Route ${index + 1} host`}
          aria-invalid={error !== undefined}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          className="aperture:min-w-0 aperture:flex-1 aperture:max-sm:basis-[calc(100%-1.625rem)]"
        />
        <ArrowRight className="aperture:size-3.5 aperture:shrink-0 aperture:text-muted-foreground aperture:max-sm:ml-6.5" />
        <Select
          items={[...upstreamNames.map((name) => ({ value: name, label: name })), ...builtin]}
          value={rule.via}
          onValueChange={(via) => onChange({ via: via ?? "direct" })}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label={`Route ${index + 1} destination`}
            className="aperture:w-36 aperture:shrink-0 aperture:max-sm:w-auto aperture:max-sm:min-w-0 aperture:max-sm:flex-1"
          >
            <SelectValue placeholder="Send to" />
          </SelectTrigger>
          <SelectContent>
            {upstreamNames.length > 0 ? (
              <>
                <SelectGroup>
                  {upstreamNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectSeparator />
              </>
            ) : null}
            <SelectGroup>
              {builtin.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="aperture:flex aperture:shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Move route up"
            onClick={() => onMove(-1)}
            disabled={disabled || index === 0}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Move route down"
            onClick={() => onMove(1)}
            disabled={disabled || index === count - 1}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove route"
            onClick={onRemove}
            disabled={disabled}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {error === undefined ? null : (
        <FieldError ref={reveal} className="aperture:pl-6.5">
          {error}
        </FieldError>
      )}
    </li>
  );
}

function UpstreamRow({
  upstream,
  error,
  disabled,
  onChange,
  onRemove,
}: {
  upstream: ProxyDraftUpstream;
  error: string | undefined;
  disabled: boolean;
  onChange: (patch: Partial<ProxyDraftUpstream>) => void;
  onRemove: () => void;
}) {
  return (
    <li data-console-proxy-upstream className="aperture:flex aperture:flex-col aperture:gap-1">
      <div className="aperture:flex aperture:items-start aperture:gap-1.5">
        <Input
          value={upstream.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="name"
          aria-label="Upstream name"
          aria-invalid={error !== undefined}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          className="aperture:w-32 aperture:shrink-0 aperture:max-sm:w-24"
        />
        <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-1.5">
          <Input
            value={upstream.url}
            onChange={(event) => onChange({ url: event.target.value })}
            placeholder="socks5://user:pass@host:1080"
            aria-label="Upstream URL"
            aria-invalid={error !== undefined}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
          />
          {isTunnelUrl(upstream.url) ? (
            <Input
              type="password"
              value={upstream.auth}
              onChange={(event) => onChange({ auth: event.target.value })}
              placeholder="Auth secret"
              aria-label="Upstream auth secret"
              autoComplete="new-password"
              disabled={disabled}
            />
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove upstream"
          onClick={onRemove}
          disabled={disabled}
        >
          <Trash2 />
        </Button>
      </div>
      {error === undefined ? null : <FieldError ref={reveal}>{error}</FieldError>}
    </li>
  );
}
