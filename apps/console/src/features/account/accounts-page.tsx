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
import { KeyRound, Link2, Plus, ShieldOff } from "lucide-react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { AccountCreateDialog } from "#/features/account/account-create-dialog.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import {
  useAccountsQuery,
  useCreateApiTokenMutation,
  useResetSecondFactorMutation,
  useSetupLinkMutation,
} from "#/features/account/account.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Every account, and a new API token for any of them. */
export function AccountsPage() {
  const accounts = useAccountsQuery();
  const setupLink = useSetupLinkMutation();
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string>();
  const resetSecondFactor = useResetSecondFactorMutation();
  const [resetting, setResetting] = useState<string>();
  const createToken = useCreateApiTokenMutation();
  const [secret, setSecret] = useState<string>();

  return (
    <div className="aperture:p-4">
      <PageHeaderActions>
        <Button data-console-account-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New account
        </Button>
      </PageHeaderActions>
      <Table scrollable={false}>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.data?.map((account) => (
            <TableRow key={account.id} data-console-account={account.name}>
              <TableCell>
                <div className="aperture:grid aperture:gap-0.5">
                  <span className="aperture:font-medium">{account.name}</span>
                  {account.email === null ? null : (
                    <span className="aperture:text-sm aperture:text-muted-foreground">
                      {account.email}
                    </span>
                  )}
                  <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                    {account.id}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={account.admin ? "default" : "outline"}>
                  {account.admin ? "admin" : account.kind}
                </Badge>
              </TableCell>
              <TableCell className="aperture:text-muted-foreground">
                {when.format(new Date(account.createdAt.epochMilliseconds))}
              </TableCell>
              <TableCell className="aperture:flex aperture:justify-end aperture:gap-1">
                {account.kind === "person" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    data-console-setup-link
                    disabled={setupLink.isPending}
                    onClick={() => setupLink.mutate(account.id, { onSuccess: setLink })}
                  >
                    <Link2 />
                    Setup link
                  </Button>
                ) : null}
                {account.kind === "person" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    data-console-reset-second-factor
                    onClick={() => setResetting(account.id)}
                  >
                    <ShieldOff />
                    Reset 2FA
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={createToken.isPending}
                  onClick={() =>
                    createToken.mutate(account.id, { onSuccess: (made) => setSecret(made.token) })
                  }
                >
                  <KeyRound />
                  New API token
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={resetting !== undefined}
        title="Turn this person's two-factor sign-in off?"
        description="For someone who lost their authenticator and backup codes. Their password stays, and they turn it on again themselves."
        confirmLabel="Turn off"
        variant="destructive"
        pending={resetSecondFactor.isPending}
        onOpenChange={(open) => (open ? undefined : setResetting(undefined))}
        onConfirm={() =>
          resetting === undefined
            ? undefined
            : resetSecondFactor.mutate(resetting, { onSettled: () => setResetting(undefined) })
        }
      />
      <AccountCreateDialog open={creating} onOpenChange={setCreating} />
      <SecretDialog title="Setup link" secret={link} onClose={() => setLink(undefined)} />
      <SecretDialog title="API token" secret={secret} onClose={() => setSecret(undefined)} />
    </div>
  );
}
