import { useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, ChevronRight, KeyRound, Plus, Trash2 } from "lucide-react";
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
import {
  DEFAULT_UPSTREAM_NAME,
  hasMaskedPassword,
  isProxyDraftEmpty,
  isTunnelUrl,
  newRule,
  newUpstream,
  type ProxyDraft,
  type ProxyDraftErrors,
  type ProxyDraftRule,
  type ProxyDraftUpstream,
} from "#/features/proxy/proxy-config.ts";

type ProxyEditorProps = {
  value: ProxyDraft;
  onChange: (draft: ProxyDraft) => void;
  errors?: ProxyDraftErrors;
  disabled?: boolean;
};

const BUILTIN_VIAS = [
  { value: "direct", label: "Direct" },
  { value: "refuse", label: "Block" },
  { value: "local", label: "Local tunnel" },
];

function secretWarning(upstream: ProxyDraftUpstream) {
  if (!upstream.needsSecret) {
    return undefined;
  }
  if (isTunnelUrl(upstream.url) && upstream.auth.trim() === "") {
    return "Re-enter the auth secret; saved secrets are never shown";
  }
  if (hasMaskedPassword(upstream.url)) {
    return "Re-enter the password; saved passwords are never shown";
  }
  return undefined;
}

function isAutoShape(draft: ProxyDraft) {
  const [rule] = draft.rules;
  return (
    draft.upstreams.length === 1 &&
    draft.rules.length === 1 &&
    rule?.match.trim() === "*" &&
    rule.via === DEFAULT_UPSTREAM_NAME
  );
}

function catchAllIndex(rules: ProxyDraftRule[]) {
  const index = rules.findIndex((rule) => rule.match.trim() === "*");
  return index === -1 ? rules.length : index;
}

export function ProxyEditor({ value, onChange, errors, disabled }: ProxyEditorProps) {
  const primary = value.upstreams.find((upstream) => upstream.name === DEFAULT_UPSTREAM_NAME);
  const others = value.upstreams.filter((upstream) => upstream !== primary);
  const showQuickField = primary !== undefined || value.upstreams.length === 0;
  const [advancedOpen, setAdvancedOpen] = useState(others.length > 0);
  const upstreamsVisible = advancedOpen || others.length > 0 || !showQuickField;
  const defaultVia = value.upstreams[0]?.name.trim() || "direct";

  function setUpstreams(upstreams: ProxyDraftUpstream[], rules = value.rules) {
    onChange({ upstreams, rules });
  }

  function updateUpstream(id: string, patch: Partial<ProxyDraftUpstream>) {
    const current = value.upstreams.find((upstream) => upstream.id === id);
    if (!current) {
      return;
    }
    let rules = value.rules;
    const nextName = patch.name;
    if (nextName !== undefined && nextName !== current.name) {
      const oldName = current.name;
      const shared = value.upstreams.some((item) => item.id !== id && item.name === oldName);
      // Keep routes pointing at the upstream while it is being renamed.
      if (oldName !== "" && !shared) {
        rules = rules.map((rule) => (rule.via === oldName ? { ...rule, via: nextName } : rule));
      }
    }
    setUpstreams(
      value.upstreams.map((upstream) =>
        upstream.id === id ? { ...upstream, ...patch } : upstream,
      ),
      rules,
    );
  }

  function setQuickUrl(url: string) {
    if (primary) {
      if (url === "" && isAutoShape(value)) {
        onChange({ upstreams: [], rules: [] });
        return;
      }
      if (url === "" && !value.rules.some((rule) => rule.via === DEFAULT_UPSTREAM_NAME)) {
        setUpstreams(value.upstreams.filter((upstream) => upstream.id !== primary.id));
        return;
      }
      updateUpstream(primary.id, { url });
      return;
    }
    if (url === "") {
      return;
    }
    const upstream = newUpstream({ name: DEFAULT_UPSTREAM_NAME, url });
    if (isProxyDraftEmpty(value)) {
      onChange({
        upstreams: [upstream],
        rules: [newRule({ match: "*", via: DEFAULT_UPSTREAM_NAME })],
      });
      return;
    }
    setUpstreams([...value.upstreams, upstream]);
  }

  function setRules(rules: ProxyDraftRule[]) {
    onChange({ upstreams: value.upstreams, rules });
  }

  function updateRule(id: string, patch: Partial<ProxyDraftRule>) {
    setRules(value.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  }

  function moveRule(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= value.rules.length) {
      return;
    }
    const rules = [...value.rules];
    const [rule] = rules.splice(index, 1);
    if (rule) {
      rules.splice(target, 0, rule);
    }
    setRules(rules);
  }

  function insertRule(index: number, rule: ProxyDraftRule) {
    const rules = [...value.rules];
    rules.splice(index, 0, rule);
    setRules(rules);
  }

  function addEverythingViaProxy() {
    const via = value.upstreams[0]?.name.trim() || DEFAULT_UPSTREAM_NAME;
    const rule = newRule({ match: "*", via });
    if (value.upstreams.length === 0) {
      onChange({
        upstreams: [newUpstream({ name: DEFAULT_UPSTREAM_NAME })],
        rules: [...value.rules, rule],
      });
      return;
    }
    setRules([...value.rules, rule]);
  }

  const hasCatchAll = value.rules.some((rule) => rule.match.trim() === "*");
  const upstreamNames = [
    ...new Set(value.upstreams.map((upstream) => upstream.name.trim()).filter(Boolean)),
  ];

  return (
    <FieldGroup>
      {showQuickField ? (
        <QuickProxyField
          upstream={primary}
          error={primary ? errors?.upstreams[primary.id] : undefined}
          disabled={disabled}
          onUrlChange={setQuickUrl}
          onAuthChange={(auth) => primary && updateUpstream(primary.id, { auth })}
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
              onClick={addEverythingViaProxy}
              disabled={disabled || hasCatchAll}
            >
              Everything via proxy
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => insertRule(0, newRule({ via: "direct" }))}
              disabled={disabled}
            >
              Add direct exception
            </Button>
          </div>
        </div>

        {value.rules.length === 0 ? (
          <p className="aperture:rounded-lg aperture:border aperture:border-dashed aperture:px-3 aperture:py-2 aperture:text-sm aperture:text-muted-foreground">
            No routes. All traffic goes direct.
          </p>
        ) : (
          <ol className="aperture:flex aperture:flex-col aperture:gap-2">
            {value.rules.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={index}
                count={value.rules.length}
                upstreamNames={upstreamNames}
                error={errors?.rules[rule.id]}
                disabled={disabled}
                onChange={(patch) => updateRule(rule.id, patch)}
                onMove={(offset) => moveRule(index, offset)}
                onRemove={() => setRules(value.rules.filter((item) => item.id !== rule.id))}
              />
            ))}
          </ol>
        )}

        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => insertRule(catchAllIndex(value.rules), newRule({ via: defaultVia }))}
            disabled={disabled}
          >
            <Plus data-icon="inline-start" />
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
            <ul className="aperture:flex aperture:flex-col aperture:gap-2">
              {others.map((upstream) => (
                <UpstreamRow
                  key={upstream.id}
                  upstream={upstream}
                  error={errors?.upstreams[upstream.id]}
                  disabled={disabled}
                  onChange={(patch) => updateUpstream(upstream.id, patch)}
                  onRemove={() =>
                    setUpstreams(value.upstreams.filter((item) => item.id !== upstream.id))
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
              onClick={() => setUpstreams([...value.upstreams, newUpstream()])}
              disabled={disabled}
            >
              <Plus data-icon="inline-start" />
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
            className="aperture:text-muted-foreground"
            onClick={() => setAdvancedOpen(true)}
            disabled={disabled}
          >
            <ChevronRight data-icon="inline-start" />
            Advanced: more upstreams
          </Button>
        </div>
      )}

      {errors?.form ? <FieldError>{errors.form}</FieldError> : null}
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
  disabled?: boolean;
  onUrlChange: (url: string) => void;
  onAuthChange: (auth: string) => void;
}) {
  const url = upstream?.url ?? "";
  const tunnel = isTunnelUrl(url);
  const message = error ?? (upstream ? secretWarning(upstream) : undefined);

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="proxy-quick-url">Proxy URL</FieldLabel>
      <Input
        id="proxy-quick-url"
        value={url}
        onChange={(event) => onUrlChange(event.target.value)}
        placeholder="socks5://user:pass@proxy.example.com:1080"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
      />
      {tunnel && upstream ? (
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
      {message ? (
        <SecretOrError message={message} isError={error !== undefined} />
      ) : (
        <FieldDescription>
          http, https, socks5 or socks5h. Leave empty to connect directly.
        </FieldDescription>
      )}
    </Field>
  );
}

function SecretOrError({ message, isError }: { message: string; isError: boolean }) {
  if (isError) {
    return <FieldError>{message}</FieldError>;
  }
  return (
    <p className="aperture:flex aperture:items-center aperture:gap-1.5 aperture:text-sm aperture:text-muted-foreground">
      <KeyRound className="aperture:size-3.5 aperture:shrink-0" />
      {message}
    </p>
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
  upstreamNames: string[];
  error: string | undefined;
  disabled?: boolean;
  onChange: (patch: Partial<ProxyDraftRule>) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
}) {
  const known = new Set([...upstreamNames, ...BUILTIN_VIAS.map((item) => item.value)]);
  const items = [
    ...upstreamNames.map((name) => ({ value: name, label: name })),
    ...BUILTIN_VIAS,
    ...(rule.via !== "" && !known.has(rule.via) ? [{ value: rule.via, label: rule.via }] : []),
  ];

  return (
    <li className="aperture:flex aperture:flex-col aperture:gap-1">
      <div className="aperture:flex aperture:items-center aperture:gap-1.5">
        <span className="aperture:w-5 aperture:shrink-0 aperture:text-right aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums">
          {index + 1}
        </span>
        <Input
          value={rule.match}
          onChange={(event) => onChange({ match: event.target.value })}
          placeholder="*.example.com"
          aria-label={`Route ${index + 1} host`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="aperture:h-8 aperture:min-w-0 aperture:flex-1"
        />
        <ArrowRight className="aperture:size-3.5 aperture:shrink-0 aperture:text-muted-foreground" />
        <Select
          items={items}
          value={rule.via}
          onValueChange={(via) => onChange({ via: via ?? "direct" })}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label={`Route ${index + 1} destination`}
            className="aperture:w-36 aperture:shrink-0"
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
              {items
                .filter((item) => !upstreamNames.includes(item.value))
                .map((item) => (
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
      {error ? <FieldError className="aperture:pl-6.5">{error}</FieldError> : null}
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
  disabled?: boolean;
  onChange: (patch: Partial<ProxyDraftUpstream>) => void;
  onRemove: () => void;
}) {
  const tunnel = isTunnelUrl(upstream.url);
  const message = error ?? secretWarning(upstream);

  return (
    <li className="aperture:flex aperture:flex-col aperture:gap-1">
      <div className="aperture:flex aperture:items-start aperture:gap-1.5">
        <Input
          value={upstream.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="name"
          aria-label="Upstream name"
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="aperture:h-8 aperture:w-32 aperture:shrink-0"
        />
        <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-1.5">
          <Input
            value={upstream.url}
            onChange={(event) => onChange({ url: event.target.value })}
            placeholder="socks5://user:pass@host:1080"
            aria-label="Upstream URL"
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="aperture:h-8"
          />
          {tunnel ? (
            <Input
              type="password"
              value={upstream.auth}
              onChange={(event) => onChange({ auth: event.target.value })}
              placeholder="Auth secret"
              aria-label="Upstream auth secret"
              autoComplete="new-password"
              disabled={disabled}
              className="aperture:h-8"
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
      {message ? <SecretOrError message={message} isError={error !== undefined} /> : null}
    </li>
  );
}
