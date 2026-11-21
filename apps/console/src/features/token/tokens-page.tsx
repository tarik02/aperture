import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@aperture-browser/ui/components/native-select";
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
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";
import {
  type ApiToken,
  useRevokeTokenMutation,
  useTokensQuery,
} from "#/features/token/token.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Shown = "active" | "revoked" | "all";

const stateOf = (token: ApiToken) => {
  if (token.revokedAt !== null) {
    return "revoked";
  }
  return token.expiresAt !== null && token.expiresAt.epochMilliseconds <= Date.now()
    ? "expired"
    : "active";
};

/** The API tokens of the account that is signed in. */
export function TokensPage() {
  const tokens = useTokensQuery();
  const revoke = useRevokeTokenMutation();
  const [shown, setShown] = useState<Shown>("active");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [revoking, setRevoking] = useState<ApiToken>();

  const listed = (tokens.data ?? []).filter((token) => {
    const state = stateOf(token);
    return shown === "all" || (shown === "active" ? state === "active" : state !== "active");
  });

  return (
    <div className="aperture:p-4">
      <PageHeaderActions>
        <NativeSelect
          size="sm"
          aria-label="Which tokens"
          value={shown}
          onChange={(event) => setShown(event.target.value as Shown)}
        >
          <NativeSelectOption value="active">Active</NativeSelectOption>
          <NativeSelectOption value="revoked">Revoked or expired</NativeSelectOption>
          <NativeSelectOption value="all">All</NativeSelectOption>
        </NativeSelect>
        <Button data-console-token-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New token
        </Button>
      </PageHeaderActions>
      <Table scrollable={false}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead />
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
        title={`Revoke ${revoking?.name ?? "this token"}?`}
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
    </div>
  );
}
