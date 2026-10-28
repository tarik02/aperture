import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { useTokenCreateFormStore } from "#/features/token/create-form/token-create-form.store.ts";
import { useTokenCreateModalStore } from "#/features/token/create-modal/token-create-modal.store.ts";
import { selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";
import * as Redacted from "effect/Redacted";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import { Switch } from "@aperture-browser/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@aperture-browser/ui/components/toggle-group";
import type { Session } from "@aperture-browser/api-client";
import { CopyButton } from "#/components/resources/copy-button.tsx";
import { CopyField } from "#/components/resources/copy-field.tsx";
import {
  DEFAULT_MCP_CLIENT_ID,
  mcpClients,
  type McpAuthMode,
  type McpCodeBlock,
  type McpSetupInput,
} from "#/features/mcp/mcp-clients.ts";

type McpScope = "tenant" | "session";

type BrowserToolProfile = "core" | "vision" | "network" | "storage";

const browserToolOptions: ReadonlyArray<{ value: BrowserToolProfile; label: string }> = [
  { value: "core", label: "Core" },
  { value: "vision", label: "Vision" },
  { value: "network", label: "Network" },
  { value: "storage", label: "Storage" },
];

const DEFAULT_BROWSER_TOOLS: ReadonlyArray<BrowserToolProfile> = ["core", "vision", "network"];

const CLIENT_STORAGE_KEY = "aperture.mcp.client";

const clientItems = mcpClients.map((client) => ({ value: client.id, label: client.name }));

function readStoredClient(): string {
  try {
    const stored = window.localStorage.getItem(CLIENT_STORAGE_KEY);
    if (stored && mcpClients.some((client) => client.id === stored)) {
      return stored;
    }
  } catch {
    // Storage can be unavailable (private mode, disabled cookies).
  }
  return DEFAULT_MCP_CLIENT_ID;
}

function storeClient(id: string) {
  try {
    window.localStorage.setItem(CLIENT_STORAGE_KEY, id);
  } catch {
    // Remembering the choice is best effort.
  }
}

function useOAuthAvailable() {
  return useQuery({
    queryKey: ["mcp", "oauth-protected-resource"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/.well-known/oauth-protected-resource/mcp", { signal });
      return response.ok;
    },
    staleTime: Infinity,
    retry: false,
  });
}

type McpSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  session?: Session | null;
};

export function McpSetupDialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  session,
}: McpSetupDialogProps) {
  const [openCount, setOpenCount] = useState(0);
  const [mounted, setMounted] = useState(open);
  const createToken = useCreateTokenShortcut();
  useEffect(() => {
    if (open) {
      setOpenCount((count) => count + 1);
      setMounted(true);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setMounted(false);
        }
        onOpenChangeComplete?.(next);
      }}
    >
      <DialogContent className="aperture:h-[min(42rem,calc(100svh-2rem))] aperture:grid-rows-[auto_minmax(0,1fr)] aperture:overflow-hidden aperture:sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect an MCP client</DialogTitle>
        </DialogHeader>
        {/* Kept mounted while closing so the exit animation shows the content; a new key on
            every open starts from fresh settings. */}
        {mounted ? (
          <McpSetupBody
            key={openCount}
            session={session ?? null}
            onCreateToken={() => {
              onOpenChange(false);
              createToken();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function McpSetupBody({
  session,
  onCreateToken,
}: {
  session: Session | null;
  onCreateToken: () => void;
}) {
  const oauth = useOAuthAvailable();
  const oauthAvailable = oauth.data === true;

  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [scope, setScope] = useState<McpScope>(session ? "session" : "tenant");
  const [tools, setTools] = useState<ReadonlyArray<BrowserToolProfile>>(DEFAULT_BROWSER_TOOLS);
  const [authChoice, setAuthChoice] = useState<McpAuthMode>("oauth");
  const [useSessionToken, setUseSessionToken] = useState(false);
  const [clientId, setClientId] = useState(readStoredClient);

  const sessionScoped = session !== null && scope === "session";
  const auth: McpAuthMode = oauthAvailable ? authChoice : "token";
  const sessionToken =
    sessionScoped && session.sessionToken ? Redacted.value(session.sessionToken) : null;
  const embedSessionToken = auth === "token" && useSessionToken && sessionToken !== null;

  const path = sessionScoped ? `/sessions/${session.id}/mcp` : "/mcp";
  // Always explicit: an operator can change the server's default set.
  const toolsQuery = `?browserTools=${tools.join(",")}`;
  const url = `${origin}${path}${toolsQuery}`;

  const input: McpSetupInput = {
    url,
    auth,
    token: embedSessionToken ? sessionToken : null,
    serverName: sessionScoped ? `aperture-${session.id.slice(0, 8)}` : "aperture",
  };

  function selectClient(id: string) {
    setClientId(id);
    storeClient(id);
  }

  function toggleTool(tool: BrowserToolProfile, checked: boolean) {
    const next = new Set(tools);
    if (checked) {
      next.add(tool);
    } else {
      next.delete(tool);
    }
    setTools(browserToolOptions.map((option) => option.value).filter((value) => next.has(value)));
  }

  return (
    <Tabs
      orientation="vertical"
      value={clientId}
      onValueChange={(value) => selectClient(String(value))}
      className="aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:gap-5"
    >
      <TabsList
        variant="line"
        className="aperture:hidden aperture:w-36 aperture:shrink-0 aperture:items-stretch aperture:self-start aperture:sm:flex"
      >
        {mcpClients.map((client) => (
          <TabsTrigger key={client.id} value={client.id}>
            {client.name}
          </TabsTrigger>
        ))}
      </TabsList>

      <div className="aperture:flex aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-3">
        <Select
          items={clientItems}
          value={clientId}
          onValueChange={(value) => {
            if (value) {
              selectClient(value);
            }
          }}
        >
          <SelectTrigger className="aperture:w-full aperture:sm:hidden" aria-label="MCP client">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {clientItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-x-4 aperture:gap-y-2">
          {session ? (
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[scope]}
              aria-label="Scope"
              onValueChange={(value) => {
                const next = value[0];
                if (next === "tenant" || next === "session") {
                  setScope(next);
                }
              }}
            >
              <ToggleGroupItem value="session">This session</ToggleGroupItem>
              <ToggleGroupItem value="tenant">All sessions</ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <div
            role="group"
            aria-label="Browser tools"
            className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-1.5"
          >
            {browserToolOptions.map((option) => (
              <label
                key={option.value}
                className="aperture:flex aperture:h-7 aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:border aperture:px-2 aperture:text-xs aperture:has-disabled:opacity-60"
              >
                <Checkbox
                  checked={tools.includes(option.value)}
                  disabled={option.value === "core"}
                  onCheckedChange={(checked) => toggleTool(option.value, checked)}
                />
                {option.label}
              </label>
            ))}
          </div>
          <label
            className="aperture:ml-auto aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm"
            title={
              oauthAvailable
                ? "Off: clients sign in with OAuth. On: clients send an API token."
                : "OAuth sign-in is not configured on this instance, so clients need a token."
            }
          >
            <Switch
              checked={auth === "token"}
              disabled={!oauthAvailable}
              onCheckedChange={(checked) => setAuthChoice(checked ? "token" : "oauth")}
            />
            API token
          </label>
        </div>

        {/* The generic client lists the URL among its fields. */}
        {mcpClients.find((client) => client.id === clientId)?.fields ? null : (
          <CopyField value={url} label="Endpoint" />
        )}

        {auth === "token" ? (
          <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-x-3 aperture:gap-y-2 aperture:rounded-lg aperture:border aperture:px-3 aperture:py-2">
            {embedSessionToken ? (
              <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-2 aperture:text-xs aperture:text-muted-foreground">
                <TriangleAlert className="aperture:size-4 aperture:shrink-0 aperture:text-amber-600" />
                Anyone with this config can control this session. It stops working when the session
                token is rotated.
              </span>
            ) : (
              <span className="aperture:min-w-0 aperture:flex-1 aperture:text-xs aperture:text-muted-foreground">
                {oauthAvailable ? "" : "OAuth sign-in isn't configured here. "}
                Use an API token with the sessions:read and sessions:write scopes.
              </span>
            )}
            {sessionToken !== null ? (
              <label className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-xs">
                <Switch size="sm" checked={useSessionToken} onCheckedChange={setUseSessionToken} />
                Use this session's token
              </label>
            ) : null}
            {embedSessionToken ? null : (
              <Button variant="outline" size="sm" onClick={onCreateToken}>
                <KeyRound data-icon="inline-start" />
                Create token
              </Button>
            )}
          </div>
        ) : null}

        <ScrollArea className="aperture:min-h-0 aperture:flex-1" viewportClassName="aperture:pr-3">
          {mcpClients.map((client) => (
            <TabsContent key={client.id} value={client.id} className="aperture:min-w-0">
              {client.fields ? (
                <dl className="aperture:grid aperture:grid-cols-[auto_minmax(0,1fr)] aperture:items-center aperture:gap-x-4 aperture:gap-y-2">
                  {client.fields(input).map((field) => (
                    <Fragment key={field.label}>
                      <dt className="aperture:text-sm aperture:text-muted-foreground">
                        {field.label}
                      </dt>
                      <dd className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:rounded-md aperture:bg-muted aperture:py-1 aperture:pr-1 aperture:pl-2.5">
                        <code
                          className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:font-mono aperture:text-xs"
                          title={field.value}
                        >
                          {field.value}
                        </code>
                        <CopyButton value={field.value} />
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              ) : null}
              <ol className="aperture:flex aperture:flex-col aperture:gap-4">
                {client.steps(input).map((step, index) => (
                  <li key={index} className="aperture:flex aperture:min-w-0 aperture:gap-3">
                    <span className="aperture:flex aperture:size-5 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-muted aperture:text-xs aperture:font-medium">
                      {index + 1}
                    </span>
                    <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-2">
                      <p className="aperture:leading-5">{step.text}</p>
                      {step.code ? <CodeBlock code={step.code} /> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </TabsContent>
          ))}
        </ScrollArea>
      </div>
    </Tabs>
  );
}

function CodeBlock({ code }: { code: McpCodeBlock }) {
  return (
    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-1">
      {code.filename ? (
        <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
          {code.filename}
        </span>
      ) : null}
      <div className="aperture:relative aperture:min-w-0">
        <pre className="aperture:rounded-lg aperture:bg-muted aperture:p-3 aperture:pr-11 aperture:font-mono aperture:text-xs aperture:break-all aperture:whitespace-pre-wrap">
          <code>{code.value}</code>
        </pre>
        <CopyButton
          value={code.value}
          className="aperture:absolute aperture:top-1.5 aperture:right-1.5"
        />
      </div>
    </div>
  );
}

/** Opens the token form on the Tokens page, prefilled for the current tenant. */
function useCreateTokenShortcut() {
  const navigate = useNavigate();
  const credentials = useApiCredentials();
  const principal = useAuthSessionStore(selectPrincipal);
  const initForm = useTokenCreateFormStore((state) => state.initForm);
  const openModal = useTokenCreateModalStore((state) => state.openModal);
  return () => {
    initForm(credentials?.selectedTenantId ?? "", principal?.resourceMode ?? "all");
    openModal();
    void navigate({ to: "/-/tokens" });
  };
}
