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
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { filter, Filters } from "#/components/filter-menu.tsx";
import { NameDialog } from "#/components/name-dialog.tsx";
import { LongName } from "#/components/long-name.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import {
  useCreateRegistrationTokenMutation,
  useRevokeRegistrationTokenMutation,
} from "#/features/node/node.mutations.ts";
import {
  type RegistrationToken,
  useRegistrationTokensQuery,
} from "#/features/node/node.queries.ts";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const SHOWN = [
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked" },
  { value: "all", label: "All" },
] as const;
type Shown = (typeof SHOWN)[number]["value"];

/** The tokens that let nodes register with this control plane. */
export function RegistrationTokensPage() {
  const tokens = useRegistrationTokensQuery();
  const create = useCreateRegistrationTokenMutation();
  const revoke = useRevokeRegistrationTokenMutation();
  const [shown, setShown] = useState<Shown>("active");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [revoking, setRevoking] = useState<RegistrationToken>();
  const revoked = useLast(revoking);

  const listed = (tokens.data ?? []).filter(
    (token) => shown === "all" || (shown === "active") === (token.revokedAt === null),
  );

  return (
    <TablePage>
      <PageHeaderActions>
        <Filters
          filters={[
            filter({ label: "Which tokens", value: shown, options: SHOWN, onChange: setShown }),
          ]}
        />
        <Button data-console-registration-token-new size="sm" onClick={() => setCreating(true)}>
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
          {tokens.data.length === 0 ? "No registration tokens yet." : "No token matches."}
        </p>
      ) : (
        <Table stickyActionColumn>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="aperture:w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {listed.map((token) => {
              const actions: ReadonlyArray<RowAction> =
                token.revokedAt === null
                  ? [
                      {
                        key: "revoke",
                        label: "Revoke",
                        icon: Ban,
                        destructive: true,
                        onSelect: () => setRevoking(token),
                      },
                    ]
                  : [];
              return (
                <RowContextMenu key={token.id} actions={actions}>
                  <TableRow data-console-registration-token={token.name}>
                    <TableCell className="aperture:font-medium">
                      <LongName>{token.name}</LongName>
                    </TableCell>
                    <TableCell>
                      <Badge variant={token.revokedAt === null ? "default" : "outline"}>
                        {token.revokedAt === null ? "active" : "revoked"}
                      </Badge>
                    </TableCell>
                    <TableCell label="Created" className="aperture:text-muted-foreground">
                      {when.format(new Date(token.createdAt.epochMilliseconds))}
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
      <NameDialog
        title="New registration token"
        open={creating}
        onOpenChange={setCreating}
        onSubmit={async (name) => setSecret((await create.mutateAsync(name)).token)}
      />
      <SecretDialog
        title="Registration token"
        secret={secret}
        onClose={() => setSecret(undefined)}
      />
      <ConfirmDialog
        open={revoking !== undefined}
        title={`Revoke ${revoked?.name ?? "this token"}?`}
        description="No new node registers with it. Nodes that did stay. This is not undone."
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
