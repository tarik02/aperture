import { Button } from "@aperture-browser/ui/components/button";
import { DialogHeader, DialogTitle } from "@aperture-browser/ui/components/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { KeyRound } from "lucide-react";
import { Fragment, useId, useRef, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { CopyButton } from "#/components/copy-button.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { DEFAULT_MCP_CLIENT, type McpCode, mcpClients } from "#/features/mcp/mcp-clients.ts";
import { useSessionsQuery } from "#/features/session/session.queries.ts";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";

const CLIENT_KEY = "aperture.mcp.client";

const clientOptions = mcpClients.map((client) => ({ value: client.id, label: client.name }));

/** The client that was set up last here: whoever comes back most likely has the same one. */
const rememberedClient = () => {
  try {
    const kept = localStorage.getItem(CLIENT_KEY);
    return mcpClients.some((client) => client.id === kept) && kept !== null
      ? kept
      : DEFAULT_MCP_CLIENT;
  } catch {
    // A browser may keep nothing for a page.
    return DEFAULT_MCP_CLIENT;
  }
};

type McpSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** How an MCP client is pointed at one of the account's running sessions. */
export function McpSetupDialog({ open, onOpenChange }: McpSetupDialogProps) {
  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      className="aperture:h-[min(42rem,calc(100svh-2rem))] aperture:grid-rows-[auto_minmax(0,1fr)] aperture:overflow-hidden aperture:sm:max-w-3xl"
    >
      <DialogHeader>
        <DialogTitle>Connect an MCP client</DialogTitle>
      </DialogHeader>
      <McpSetup />
    </FreshDialog>
  );
}

function McpSetup() {
  const sessions = useSessionsQuery();
  const sessionId = useId();
  const [chosen, setChosen] = useState<string>();
  const [clientId, setClientId] = useState(rememberedClient);
  const [makingToken, setMakingToken] = useState(false);
  const makeToken = useRef<HTMLButtonElement>(null);
  /** A token made from here, which the steps then have in them. */
  const [token, setToken] = useState<string>();

  const running = (sessions.data ?? []).filter(
    (session) => session.path !== null && session.observedState === "running",
  );
  const session = running.find((one) => one.id === chosen) ?? running[0];

  if (session === undefined) {
    return (
      <p
        data-console-mcp
        data-console-mcp-none
        className="aperture:text-sm aperture:text-muted-foreground"
      >
        {sessions.data === undefined
          ? "Asking for the sessions…"
          : "Each session has an MCP server of its own, and no session runs now. Start one, and come back for how to connect to it."}
      </p>
    );
  }

  const url = `${location.origin}${session.path}/mcp`;
  const setup = { url, token, name: `aperture-${session.id.slice(0, 8)}` };
  const selectClient = (id: string) => {
    setClientId(id);
    try {
      localStorage.setItem(CLIENT_KEY, id);
    } catch {
      // Remembered where the browser lets it be.
    }
  };

  return (
    <Tabs
      data-console-mcp
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
          <TabsTrigger key={client.id} value={client.id} data-console-mcp-client={client.id}>
            {client.name}
          </TabsTrigger>
        ))}
      </TabsList>

      <div className="aperture:flex aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-3">
        <Choice
          className="aperture:w-full aperture:sm:hidden"
          aria-label="MCP client"
          value={clientId}
          options={clientOptions}
          onChange={selectClient}
        />

        <div className="aperture:grid aperture:grid-cols-[5rem_minmax(0,1fr)] aperture:items-center aperture:gap-x-3 aperture:gap-y-2">
          <label htmlFor={sessionId} className="aperture:text-xs aperture:text-muted-foreground">
            Session
          </label>
          <Choice
            id={sessionId}
            className="aperture:w-full"
            value={session.id}
            options={running.map((one) => ({ value: one.id, label: one.label ?? one.id }))}
            onChange={setChosen}
          />
          {/* The client for the others lists the address among what it is given. */}
          {mcpClients.find((client) => client.id === clientId)?.fields === undefined ? (
            <>
              <span className="aperture:text-xs aperture:text-muted-foreground">Endpoint</span>
              <InputGroup>
                <InputGroupInput
                  readOnly
                  value={url}
                  aria-label="Endpoint"
                  className="aperture:font-mono aperture:text-xs aperture:md:text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <InputGroupAddon align="inline-end">
                  <CopyButton value={url} variant="ghost" size="icon-xs" />
                </InputGroupAddon>
              </InputGroup>
            </>
          ) : null}
        </div>

        <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-x-3 aperture:gap-y-2 aperture:rounded-lg aperture:border aperture:px-3 aperture:py-2">
          <span className="aperture:min-w-0 aperture:flex-1 aperture:text-xs aperture:text-muted-foreground">
            {token === undefined
              ? "Each session has an MCP server of its own, which takes an API token with the sessions:write scope."
              : "The steps have the token you just made in them. It is not shown again once this is closed."}
          </span>
          <Button
            ref={makeToken}
            type="button"
            size="sm"
            variant="outline"
            data-console-mcp-token
            onClick={() => setMakingToken(true)}
          >
            <KeyRound />
            Create token
          </Button>
        </div>

        <ScrollArea className="aperture:min-h-0 aperture:flex-1" viewportClassName="aperture:pr-3">
          {mcpClients.map((client) => (
            <TabsContent key={client.id} value={client.id} className="aperture:min-w-0">
              {client.fields === undefined ? null : (
                <dl className="aperture:grid aperture:grid-cols-[auto_minmax(0,1fr)] aperture:items-center aperture:gap-x-4 aperture:gap-y-2">
                  {client.fields(setup).map((field) => (
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
              )}
              <ol className="aperture:flex aperture:flex-col aperture:gap-4">
                {client.steps(setup).map((step, index) => (
                  <li key={index} className="aperture:flex aperture:min-w-0 aperture:gap-3">
                    <span className="aperture:flex aperture:size-5 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-muted aperture:text-xs aperture:font-medium">
                      {index + 1}
                    </span>
                    <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-2">
                      <p className="aperture:leading-5">{step.text}</p>
                      {step.code === undefined ? null : <CodeBlock code={step.code} />}
                    </div>
                  </li>
                ))}
              </ol>
            </TabsContent>
          ))}
        </ScrollArea>
      </div>
      <TokenCreateDialog
        open={makingToken}
        onOpenChange={setMakingToken}
        // What drives one session needs no more than that session.
        initial={{
          scopes: ["sessions:write"],
          resources: [{ kind: "sessions", id: session.id }],
        }}
        // Back within this dialog, so that it is still the one the keyboard works.
        finalFocus={makeToken}
        onCreated={setToken}
      />
    </Tabs>
  );
}

function CodeBlock({ code }: { code: McpCode }) {
  return (
    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-1">
      {code.filename === undefined ? null : (
        <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
          {code.filename}
        </span>
      )}
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
