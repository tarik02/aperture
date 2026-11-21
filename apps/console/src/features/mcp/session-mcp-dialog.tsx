import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { KeyRound } from "lucide-react";
import { useRef, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { DEFAULT_MCP_CLIENT, mcpClients } from "#/features/mcp/mcp-clients.ts";
import {
  McpEndpoint,
  McpSteps,
  rememberClient,
  rememberedClient,
} from "#/features/mcp/mcp-steps.tsx";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";

/** A session's own server takes a token and nothing else, so a client that only signs in is left out. */
const clients = mcpClients.filter((client) => client.id !== "claude-desktop");
const clientOptions = clients.map((client) => ({ value: client.id, label: client.name }));

type SessionMcpDialogProps = {
  session: { readonly id: string; readonly path: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** How an MCP client is pointed at one session's own server, which drives that session alone. */
export function SessionMcpDialog({ session, open, onOpenChange }: SessionMcpDialogProps) {
  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      className="aperture:sm:max-w-xl"
      height="36rem"
    >
      <DialogHeader>
        <DialogTitle>Connect MCP</DialogTitle>
        <DialogDescription>
          This session's own server, for a client that drives it alone.
        </DialogDescription>
      </DialogHeader>
      <SessionMcpSteps session={session} />
    </FreshDialog>
  );
}

function SessionMcpSteps({ session }: Pick<SessionMcpDialogProps, "session">) {
  const [clientId, setClientId] = useState(() => rememberedClient(clients, DEFAULT_MCP_CLIENT));
  const [makingToken, setMakingToken] = useState(false);
  const makeToken = useRef<HTMLButtonElement>(null);
  const [token, setToken] = useState<string>();
  const client = clients.find((one) => one.id === clientId) ?? clients[0];
  const url = `${location.origin}${session.path ?? ""}/mcp`;

  return (
    <>
      <div
        data-console-session-mcp
        className="aperture:flex aperture:shrink-0 aperture:flex-col aperture:gap-3"
      >
        <McpEndpoint url={url} />
        <div className="aperture:flex aperture:items-center aperture:gap-2">
          <Choice
            className="aperture:min-w-0 aperture:flex-1"
            aria-label="MCP client"
            value={clientId}
            options={clientOptions}
            onChange={(id) => {
              setClientId(id);
              rememberClient(id);
            }}
          />
          <Button
            ref={makeToken}
            type="button"
            variant="outline"
            data-console-mcp-token
            onClick={() => setMakingToken(true)}
          >
            <KeyRound />
            Create token
          </Button>
        </div>
      </div>
      <DialogBody>
        {client === undefined ? null : (
          <McpSteps
            client={client}
            setup={{ url, auth: "token", token, name: `aperture-${session.id.slice(0, 8)}` }}
          />
        )}
      </DialogBody>
      <TokenCreateDialog
        open={makingToken}
        onOpenChange={setMakingToken}
        // What drives one session needs no more than that session.
        initial={{
          scopes: ["sessions:write"],
          resources: [{ kind: "sessions", id: session.id }],
        }}
        finalFocus={makeToken}
        onCreated={setToken}
      />
    </>
  );
}
