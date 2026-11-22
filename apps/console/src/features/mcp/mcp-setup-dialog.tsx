import { Button } from "@aperture-browser/ui/components/button";
import { DialogHeader, DialogTitle } from "@aperture-browser/ui/components/dialog";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@aperture-browser/ui/components/toggle-group";
import { KeyRound } from "lucide-react";
import { useRef, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { DEFAULT_MCP_CLIENT, type McpSetup, mcpClients } from "#/features/mcp/mcp-clients.ts";
import {
  McpEndpoint,
  McpSteps,
  rememberClient,
  rememberedClient,
} from "#/features/mcp/mcp-steps.tsx";
import { useAccess } from "#/features/auth/access.ts";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";

const clientOptions = mcpClients.map((client) => ({ value: client.id, label: client.name }));

const WAYS = [
  { value: "oauth", label: "Sign in" },
  { value: "token", label: "API token" },
] as const;

type McpSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** How an MCP client is pointed at the account's sessions, all of them through one server. */
export function McpSetupDialog({ open, onOpenChange }: McpSetupDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} className="aperture:sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Connect an MCP client</DialogTitle>
      </DialogHeader>
      <McpSetupSteps />
    </FreshDialog>
  );
}

function McpSetupSteps() {
  const [clientId, setClientId] = useState(() => rememberedClient(mcpClients, DEFAULT_MCP_CLIENT));
  const [auth, setAuth] = useState<McpSetup["auth"]>("oauth");
  const { makesTokens } = useAccess();
  const [makingToken, setMakingToken] = useState(false);
  const makeToken = useRef<HTMLButtonElement>(null);
  /** A token made from here, which the steps then have in them. */
  const [token, setToken] = useState<string>();

  const url = `${location.origin}/mcp`;
  const setup: McpSetup = { url, auth, token, name: "aperture" };
  const selectClient = (id: string) => {
    setClientId(id);
    rememberClient(id);
  };

  return (
    <Tabs
      data-console-mcp
      data-console-mcp-auth={auth}
      orientation="vertical"
      value={clientId}
      onValueChange={(value) => selectClient(String(value))}
      className="aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:gap-5"
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

        <div className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-3">
          <ToggleGroup
            aria-label="How the client is let in"
            variant="outline"
            size="sm"
            spacing={0}
            value={[auth]}
            // One of the two is always chosen: pressing the chosen one leaves it so.
            onValueChange={([next]) =>
              setAuth(WAYS.find((way) => way.value === next)?.value ?? auth)
            }
          >
            {WAYS.map((way) => (
              <ToggleGroupItem key={way.value} value={way.value} data-console-mcp-way={way.value}>
                {way.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="aperture:min-w-0 aperture:flex-1">
            <McpEndpoint url={url} />
          </div>
        </div>

        {/* As tall whichever way is chosen, so nothing below it moves. */}
        <div className="aperture:flex aperture:h-14 aperture:shrink-0 aperture:items-center aperture:gap-x-3 aperture:gap-y-2 aperture:rounded-lg aperture:border aperture:px-3 aperture:py-2">
          <span className="aperture:min-w-0 aperture:flex-1 aperture:text-xs aperture:text-muted-foreground">
            {auth === "oauth"
              ? "The client opens your browser here, and you choose there what it may do."
              : token === undefined
                ? "The client sends an API token, which does what its scopes say."
                : "The steps have the token you just made in them. It is not shown again once this is closed."}
          </span>
          {auth === "token" && makesTokens ? (
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
          ) : null}
        </div>

        {/*
          What most clients are set up with fits; the ones with a file to write are several
          times as long, and scroll.
        */}
        <ScrollArea
          className="aperture:flex aperture:min-h-0 aperture:shrink aperture:grow-0 aperture:basis-[23rem] aperture:flex-col"
          viewportClassName="aperture:h-auto aperture:min-h-0 aperture:flex-1 aperture:pr-3"
        >
          {mcpClients.map((client) => (
            <TabsContent key={client.id} value={client.id} className="aperture:min-w-0">
              <McpSteps client={client} setup={setup} />
            </TabsContent>
          ))}
        </ScrollArea>
      </div>
      <TokenCreateDialog
        open={makingToken}
        onOpenChange={setMakingToken}
        // What drives sessions needs no more than that.
        initial={{ scopes: ["sessions:write", "snapshots:read"], resources: [] }}
        // Back within this dialog, so that it is still the one the keyboard works.
        finalFocus={makeToken}
        onCreated={setToken}
      />
    </Tabs>
  );
}
