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
import { Ban, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { filter, Filters } from "#/components/filter-menu.tsx";
import { LongName } from "#/components/long-name.tsx";
import { ScopeList } from "#/components/scope-list.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useAccess } from "#/features/auth/access.ts";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";
import { useRevokeTokenMutation } from "#/features/token/token.mutations.ts";
import { type ApiToken, useTokensQuery } from "#/features/token/token.queries.ts";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { useListSearch } from "#/lib/list-search.ts";
import { useLast } from "#/lib/use-last.ts";
import { worded } from "#/lib/words.ts";
import { ListEmpty, ListNoMatch } from "#/components/list-empty.tsx";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Which tokens are listed, as the page's address keeps it. */
export const TOKENS_SEARCH = { show: ["active", "revoked", "all"] } as const;

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
  account?: { readonly id: string; readonly name: string; readonly admin: boolean } | undefined;
  /** Whether whose tokens they are is not known yet: none are asked for until it is. */
  waiting?: boolean;
};

/** The API tokens of the account that is signed in, or of the one an admin looks at. */
export function TokensPage({ account, waiting = false }: TokensPageProps) {
  const tokens = useTokensQuery(account?.id, !waiting);
  const revoke = useRevokeTokenMutation(account?.id);
  const access = useAccess();
  // An admin makes another account's as an admin; their own, whoever makes tokens at all.
  const makes = !waiting && (account === undefined ? access.makesTokens : access.may("admin"));
  const [{ show: shown }, setList] = useListSearch(TOKENS_SEARCH);
  const setShown = (show: Shown) => setList({ show });
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
        {makes ? (
          <Button data-console-token-new size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New token
          </Button>
        ) : null}
      </PageHeaderActions>
      {tokens.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(tokens.error)}
        </p>
      ) : tokens.isSuccess && listed.length === 0 ? (
        shown !== "active" ? (
          <ListNoMatch title="No token matches" onClear={() => setShown("active")} />
        ) : (
          <ListEmpty
            icon={KeyRound}
            title={tokens.data.length === 0 ? "No API tokens yet" : "No active API tokens"}
          >
            {makes ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                New token
              </Button>
            ) : null}
          </ListEmpty>
        )
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
            {tokens.isPending ? <TableRowsSkeleton columns={7} actions /> : null}
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
                      <Badge variant={state === "active" ? "default" : "outline"}>
                        {worded(state)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ScopeList scopes={token.scopes} mark="data-console-token-scope" />
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
