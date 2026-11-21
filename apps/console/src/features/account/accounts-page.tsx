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
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { NameForm } from "#/components/name-form.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import {
  useAccountsQuery,
  useCreateAccountMutation,
  useCreateApiTokenMutation,
} from "#/features/account/account.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Every account, and a new API token for any of them. */
export function AccountsPage() {
  const accounts = useAccountsQuery();
  const create = useCreateAccountMutation();
  const createToken = useCreateApiTokenMutation();
  const [secret, setSecret] = useState<string>();

  return (
    <div className="aperture:p-4">
      <PageHeaderActions>
        <NameForm
          placeholder="Account name"
          label="New account"
          pending={create.isPending}
          onSubmit={(name) => create.mutate(name)}
        />
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
              <TableCell className="aperture:text-right">
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
      <SecretDialog title="API token" secret={secret} onClose={() => setSecret(undefined)} />
    </div>
  );
}
