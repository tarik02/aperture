import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";
import { useRevokeTokenMutation } from "#/features/token/token.mutations.ts";
import { type ApiToken, useTokensQuery } from "#/features/token/token.queries.ts";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const SHOWN = [
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked or expired" },
  { value: "all", label: "All" },
] as const;
type Shown = (typeof SHOWN)[number]["value"];

const stateOf = (token: ApiToken) => {
  if (token.revokedAt !== null) {
    return "revoked";
  }
  return token.expiresAt !== null && token.expiresAt.epochMilliseconds <= Date.now()
    ? "expired"
    : "active";
};

const HELD_TO = [
  ["workspaces", "workspace"],
  ["sessions", "session"],
  ["snapshots", "snapshot"],
] as const;

/** What a token reaches: all its account does, or how many of each thing it is held to. */
function TokenReach({ resources }: { resources: ApiToken["resources"] }) {
  if (resources === null) {
    return (
      <Badge variant="secondary" className="aperture:font-normal">
        All resources
      </Badge>
    );
  }
  return (
    <span className="aperture:flex aperture:gap-1">
      {HELD_TO.filter(([kind]) => resources[kind].length > 0).map(([kind, one]) => (
        <Badge
          key={kind}
          variant="outline"
          className="aperture:font-normal"
          data-console-token-resource={kind}
          title={resources[kind].join("\n")}
        >
          {resources[kind].length} {one}
          {resources[kind].length === 1 ? "" : "s"}
        </Badge>
      ))}
    </span>
  );
}

/** The API tokens of the account that is signed in. */
export function TokensPage() {
  const tokens = useTokensQuery();
  const revoke = useRevokeTokenMutation();
  const [shown, setShown] = useState<Shown>("active");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [revoking, setRevoking] = useState<ApiToken>();
  const revoked = useLast(revoking);

  const listed = (tokens.data ?? []).filter((token) => {
    const state = stateOf(token);
    return shown === "all" || (shown === "active" ? state === "active" : state !== "active");
  });

  return (
    <TablePage>
      <PageHeaderActions>
        <Choice
          size="sm"
          aria-label="Which tokens"
          value={shown}
          options={SHOWN}
          onChange={setShown}
        />
        <Button data-console-token-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New token
        </Button>
      </PageHeaderActions>
      {tokens.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(tokens.error)}
        </p>
      ) : null}
      <Table stickyActionColumn>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Resources</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="aperture:w-px" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {listed.map((token) => {
            const state = stateOf(token);
            return (
              <TableRow key={token.id} data-console-token={token.name}>
                <TableCell className="aperture:font-medium">{token.name}</TableCell>
                <TableCell>
                  <Badge variant={state === "active" ? "default" : "outline"}>{state}</Badge>
                </TableCell>
                <TableCell>
                  {token.scopes === null ? (
                    <span className="aperture:text-muted-foreground">Everything</span>
                  ) : (
                    <span className="aperture:flex aperture:max-w-64 aperture:flex-wrap aperture:gap-1">
                      {token.scopes.map((scope) => (
                        <Badge key={scope} variant="secondary" data-console-token-scope={scope}>
                          {scope}
                        </Badge>
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <TokenReach resources={token.resources} />
                </TableCell>
                <TableCell className="aperture:text-muted-foreground">
                  {when.format(new Date(token.createdAt.epochMilliseconds))}
                </TableCell>
                <TableCell className="aperture:text-muted-foreground">
                  {token.expiresAt === null
                    ? "Never"
                    : when.format(new Date(token.expiresAt.epochMilliseconds))}
                </TableCell>
                <TableCell className="aperture:text-right">
                  {state === "active" ? (
                    <Button size="sm" variant="outline" onClick={() => setRevoking(token)}>
                      Revoke
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <TokenCreateDialog open={creating} onOpenChange={setCreating} onCreated={setSecret} />
      <SecretDialog title="API token" secret={secret} onClose={() => setSecret(undefined)} />
      <ConfirmDialog
        open={revoking !== undefined}
        title={`Revoke ${revoked?.name ?? "this token"}?`}
        description="Whatever uses it is let in no more. This is not undone."
        confirmLabel="Revoke"
        variant="destructive"
        pending={revoke.isPending}
        onOpenChange={(open) => (open ? undefined : setRevoking(undefined))}
        onConfirm={() =>
          revoking === undefined
            ? undefined
            : revoke.mutate(revoking.id, { onSettled: () => setRevoking(undefined) })
        }
      />
    </TablePage>
  );
}
