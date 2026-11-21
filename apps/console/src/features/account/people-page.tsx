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
import { Link2, Plus, ShieldOff } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { AccountCell } from "#/features/account/account-cell.tsx";
import {
  useResetSecondFactorMutation,
  useSetupLinkMutation,
} from "#/features/account/account.mutations.ts";
import { type Account, useAccountsQuery } from "#/features/account/account.queries.ts";
import { PersonCreateDialog } from "#/features/account/person-create-dialog.tsx";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The people who sign in: each with the way to a password, and out of a lost second factor. */
export function PeoplePage() {
  const accounts = useAccountsQuery();
  const setupLink = useSetupLinkMutation();
  const resetSecondFactor = useResetSecondFactorMutation();
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string>();
  const [resetting, setResetting] = useState<Account>();
  const reset = useLast(resetting);
  const people = accounts.data?.filter((account) => account.kind === "person");

  return (
    <div className="aperture:p-4">
      <PageHeaderActions>
        <Button data-console-person-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New person
        </Button>
      </PageHeaderActions>
      {accounts.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(accounts.error)}
        </p>
      ) : people?.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          Nobody yet. A person signs in with their email, once they set a password.
        </p>
      ) : (
        <Table scrollable={false}>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {people?.map((account) => (
              <TableRow key={account.id} data-console-person={account.name}>
                <TableCell>
                  <AccountCell account={account} />
                </TableCell>
                <TableCell>
                  <Badge variant={account.admin ? "default" : "outline"}>
                    {account.admin ? "admin" : "member"}
                  </Badge>
                </TableCell>
                <TableCell className="aperture:text-muted-foreground">
                  {when.format(new Date(account.createdAt.epochMilliseconds))}
                </TableCell>
                <TableCell>
                  <div className="aperture:flex aperture:justify-end aperture:gap-1">
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
                    <Button
                      size="sm"
                      variant="outline"
                      data-console-reset-second-factor
                      onClick={() => setResetting(account)}
                    >
                      <ShieldOff />
                      Reset 2FA
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={resetting !== undefined}
        title={`Turn two-factor sign-in off for ${reset?.name ?? "this person"}?`}
        description="For someone who lost their authenticator and backup codes. Their password stays, and they turn it on again themselves."
        confirmLabel="Turn off"
        variant="destructive"
        pending={resetSecondFactor.isPending}
        onOpenChange={(open) => (open ? undefined : setResetting(undefined))}
        onConfirm={() =>
          resetting === undefined
            ? undefined
            : resetSecondFactor.mutate(resetting.id, { onSettled: () => setResetting(undefined) })
        }
      />
      <PersonCreateDialog open={creating} onOpenChange={setCreating} />
      <SecretDialog title="Setup link" secret={link} onClose={() => setLink(undefined)} />
    </div>
  );
}
