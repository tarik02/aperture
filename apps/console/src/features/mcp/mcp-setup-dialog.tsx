import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Field, FieldLabel } from "@aperture-browser/ui/components/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { KeyRound } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { CopyField } from "#/components/copy-field.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { mcpClients } from "#/features/mcp/mcp-clients.ts";
import { useSessionsQuery } from "#/features/session/session.queries.ts";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";

type McpSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** How an MCP client is pointed at one of the account's running sessions. */
export function McpSetupDialog({ open, onOpenChange }: McpSetupDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} className="aperture:sm:max-w-2xl">
      <McpSetup />
    </FreshDialog>
  );
}

function McpSetup() {
  const sessions = useSessionsQuery();
  const sessionId = useId();
  const [chosen, setChosen] = useState<string>();
  const [client, setClient] = useState(mcpClients[0]?.id ?? "");
  const [makingToken, setMakingToken] = useState(false);
  const makeToken = useRef<HTMLButtonElement>(null);
  /** A token made from here, which the snippets then have in them. */
  const [token, setToken] = useState<string>();

  const running = (sessions.data ?? []).filter(
    (session) => session.path !== null && session.observedState === "running",
  );
  const session = running.find((one) => one.id === chosen) ?? running[0];
  const url = session === undefined ? undefined : `${location.origin}${session.path}/mcp`;

  return (
    <div data-console-mcp className="aperture:grid aperture:min-w-0 aperture:gap-4">
      <DialogHeader>
        <DialogTitle>Connect an MCP client</DialogTitle>
        <DialogDescription>
          Each session has an MCP server of its own, which drives that session's browser. It takes
          an API token of this account as a bearer token.
        </DialogDescription>
      </DialogHeader>
      {session === undefined || url === undefined ? (
        <p data-console-mcp-none className="aperture:text-sm aperture:text-muted-foreground">
          {sessions.data === undefined
            ? "Asking for the sessions…"
            : "No session runs now. Start one, and come back for how to connect to it."}
        </p>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor={sessionId}>Session</FieldLabel>
            <Choice
              id={sessionId}
              className="aperture:w-full"
              value={session.id}
              options={running.map((one) => ({ value: one.id, label: one.label ?? one.id }))}
              onChange={setChosen}
            />
          </Field>
          <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-x-3 aperture:gap-y-2 aperture:rounded-lg aperture:border aperture:px-3 aperture:py-2">
            <span className="aperture:min-w-0 aperture:flex-1 aperture:text-xs aperture:text-muted-foreground">
              {token === undefined
                ? "Put an API token where the snippets say <API token>: one with sessions:write drives the session."
                : "The snippets have the token you just made in them. It is not shown again once this is closed."}
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
              Make a token
            </Button>
          </div>
          <Tabs value={client} onValueChange={(value) => setClient(String(value))}>
            <TabsList>
              {mcpClients.map((one) => (
                <TabsTrigger key={one.id} value={one.id}>
                  {one.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {mcpClients.map((one) => (
              <TabsContent
                key={one.id}
                value={one.id}
                className="aperture:grid aperture:gap-3 aperture:pt-2"
              >
                {one.snippets({ url, token }).map((snippet) => (
                  <CopyField key={snippet.label} label={snippet.label} value={snippet.value} />
                ))}
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}
      <TokenCreateDialog
        open={makingToken}
        onOpenChange={setMakingToken}
        // Back within this dialog, so that it is still the one the keyboard works.
        finalFocus={makeToken}
        onCreated={setToken}
      />
    </div>
  );
}
