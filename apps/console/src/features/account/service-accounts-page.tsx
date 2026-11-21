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
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { NameDialog } from "#/components/name-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { AccountCell } from "#/features/account/account-cell.tsx";
import { useCreateAccountMutation } from "#/features/account/account.mutations.ts";
import { type Account, useAccountsQuery } from "#/features/account/account.queries.ts";
import { TokenCreateDialog } from "#/features/token/token-create-dialog.tsx";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The accounts of what is not a person: each comes with API tokens alone. */
export function ServiceAccountsPage() {
  const accounts = useAccountsQuery();
  const create = useCreateAccountMutation();
  const [creating, setCreating] = useState(false);
  const [tokenFor, setTokenFor] = useState<Account>();
  const tokenAccount = useLast(tokenFor);
  const [secret, setSecret] = useState<string>();
  const services = accounts.data?.filter((account) => account.kind === "service");

  return (
    <TablePage>
      <PageHeaderActions>
        <Button data-console-service-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New service account
        </Button>
      </PageHeaderActions>
      {accounts.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(accounts.error)}
        </p>
      ) : services?.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          No service accounts yet. One is for automation: it has API tokens and no password.
        </p>
      ) : (
        <Table stickyActionColumn>
          <TableHeader>
            <TableRow>
              <TableHead>Service account</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="aperture:w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {services?.map((account) => (
              <TableRow key={account.id} data-console-service={account.name}>
                <TableCell>
                  <AccountCell account={account} />
                </TableCell>
                <TableCell>
                  <Badge variant={account.admin ? "default" : "outline"}>
                    {account.admin ? "admin" : "service"}
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
                      data-console-service-token
                      onClick={() => setTokenFor(account)}
                    >
                      <KeyRound />
                      New API token
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <NameDialog
        title="New service account"
        description="An account for automation. It signs in nowhere: it is used with API tokens, made here."
        open={creating}
        onOpenChange={setCreating}
        onSubmit={(name) => create.mutateAsync({ name })}
      />
      <TokenCreateDialog
        account={tokenAccount}
        open={tokenFor !== undefined}
        onOpenChange={(open) => (open ? undefined : setTokenFor(undefined))}
        onCreated={setSecret}
      />
      <SecretDialog title="API token" secret={secret} onClose={() => setSecret(undefined)} />
    </TablePage>
  );
}
