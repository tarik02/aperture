import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@aperture-browser/ui/components/alert";
import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@aperture-browser/ui/components/field";
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
import { cn } from "@aperture-browser/ui/utils";
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent className="aperture:sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect an MCP client</DialogTitle>
          <DialogDescription>
            Let AI agents create and drive browser sessions in Aperture.
          </DialogDescription>
        </DialogHeader>
        {open ? <McpSetupBody session={session ?? null} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function McpSetupBody({ session }: { session: Session | null }) {
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
    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-4">
      <div className="aperture:grid aperture:gap-4 aperture:sm:grid-cols-2">
        {session ? (
          <Field>
            <FieldLabel>Scope</FieldLabel>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[scope]}
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
          </Field>
        ) : null}

        <Field>
          <FieldLabel>Authentication</FieldLabel>
          {oauthAvailable ? (
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[authChoice]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "oauth" || next === "token") {
                  setAuthChoice(next);
                }
              }}
            >
              <ToggleGroupItem value="oauth">Sign in with OAuth (recommended)</ToggleGroupItem>
              <ToggleGroupItem value="token">API token</ToggleGroupItem>
            </ToggleGroup>
          ) : (
            <FieldDescription>
              {oauth.isPending
                ? "Checking sign-in options…"
                : "OAuth sign-in is not configured on this instance, so clients need a token."}
            </FieldDescription>
          )}
        </Field>

        <Field className={cn(!session && "aperture:sm:col-span-2")}>
          <FieldTitle>Browser tools</FieldTitle>
          <div className="aperture:flex aperture:flex-wrap aperture:gap-2">
            {browserToolOptions.map((option) => (
              <label
                key={option.value}
                className="aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:border aperture:px-2.5 aperture:py-1 aperture:text-xs aperture:has-disabled:opacity-60"
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
        </Field>
      </div>

      {auth === "token" ? (
        <div className="aperture:flex aperture:flex-col aperture:gap-2">
          {sessionToken !== null ? (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Use this session's token</FieldTitle>
                <FieldDescription>
                  Embed the session token instead of an API token.
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={useSessionToken}
                onCheckedChange={setUseSessionToken}
                aria-label="Use this session's token"
              />
            </Field>
          ) : null}
          {embedSessionToken ? (
            <Alert>
              <TriangleAlert />
              <AlertDescription>
                Anyone with this config can control this session. It stops working when the session
                token is rotated.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:justify-between aperture:gap-2 aperture:rounded-lg aperture:border aperture:px-3 aperture:py-2">
              <span className="aperture:min-w-0 aperture:flex-1 aperture:text-xs aperture:text-muted-foreground">
                Use an API token with the sessions:read and sessions:write scopes. Snapshot tools
                also need snapshot scopes.
              </span>
              <Button variant="outline" size="sm" render={<Link to="/-/tokens" />}>
                <KeyRound />
                Create an API token
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <CopyField value={url} label="Endpoint" />

      <Tabs
        orientation="vertical"
        value={clientId}
        onValueChange={(value) => selectClient(String(value))}
        className="aperture:min-w-0 aperture:gap-4"
      >
        <TabsList
          variant="line"
          className="aperture:hidden aperture:w-40 aperture:shrink-0 aperture:items-stretch aperture:sm:flex"
        >
          {mcpClients.map((client) => (
            <TabsTrigger key={client.id} value={client.id}>
              {client.name}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-3">
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
          {mcpClients.map((client) => (
            <TabsContent key={client.id} value={client.id} className="aperture:min-w-0">
              <p className="aperture:mb-3 aperture:text-xs aperture:text-muted-foreground">
                {client.description}
              </p>
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
        </div>
      </Tabs>
    </div>
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
