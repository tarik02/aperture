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
import { Ban, Plus } from "lucide-react";
import { useState } from "react";
import { filter, Filters } from "#/components/filter-menu.tsx";
import { LongName } from "#/components/long-name.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
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

type TokensPageProps = {
  /** Whose tokens they are, where they are not the one's who is signed in: a service account's. */
  account?: { readonly id: string; readonly name: string; readonly admin: boolean };
};

/** The API tokens of the account that is signed in, or of the one an admin looks at. */
export function TokensPage({ account }: TokensPageProps) {
  const tokens = useTokensQuery(account?.id);
  const revoke = useRevokeTokenMutation(account?.id);
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
        <Filters
          filters={[
            filter({ label: "Which tokens", value: shown, options: SHOWN, onChange: setShown }),
          ]}
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
      ) : tokens.isSuccess && listed.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          {tokens.data.length === 0 ? "No API tokens yet." : "No token matches."}
        </p>
      ) : (
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
              const actions: ReadonlyArray<RowAction> =
                state === "active"
                  ? [
                      {
                        key: "revoke",
                        label: "Revoke",
                        icon: Ban,
                        destructive: true,
                        shown: "button",
                        onSelect: () => setRevoking(token),
                      },
                    ]
                  : [];
              return (
                <RowContextMenu key={token.id} actions={actions}>
                  <TableRow data-console-token={token.name}>
                    <TableCell className="aperture:font-medium">
                      <LongName>{token.name}</LongName>
                    </TableCell>
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
                    <TableCell label="Created" className="aperture:text-muted-foreground">
                      {when.format(new Date(token.createdAt.epochMilliseconds))}
                    </TableCell>
                    <TableCell label="Expires" className="aperture:text-muted-foreground">
                      {token.expiresAt === null
                        ? "Never"
                        : when.format(new Date(token.expiresAt.epochMilliseconds))}
                    </TableCell>
                    <TableCell>
                      <RowActions actions={actions} label="Token actions" />
                    </TableCell>
                  </TableRow>
                </RowContextMenu>
              );
            })}
          </TableBody>
        </Table>
      )}
      <TokenCreateDialog
        account={account}
        open={creating}
        onOpenChange={setCreating}
        onCreated={setSecret}
      />
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
