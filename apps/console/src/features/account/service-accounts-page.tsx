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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { NameDialog } from "#/components/name-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { AccountCell } from "#/features/account/account-cell.tsx";
import {
  useCreateAccountMutation,
  useDisableAccountMutation,
  useRemoveAccountMutation,
} from "#/features/account/account.mutations.ts";
import { type Account, useAccountsQuery } from "#/features/account/account.queries.ts";
import {
  PersonActionsMenu,
  PersonContextMenu,
  type ServiceDoing,
  serviceActions,
} from "#/features/account/person-actions-menu.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What is asked again before it is done to a service account. */
type Confirming = Extract<ServiceDoing, "disable" | "delete">;

const CONFIRM: Record<
  Confirming,
  { title: (name: string) => string; description: string; confirmLabel: string }
> = {
  disable: {
    title: (name) => `Disable ${name}?`,
    description: "Its API tokens stop working. What is its stays.",
    confirmLabel: "Disable",
  },
  delete: {
    title: (name) => `Delete ${name}?`,
    description: "Its API tokens and places in workspaces go with it. This is not undone.",
    confirmLabel: "Delete",
  },
};

/**
 * The accounts of what is not a person: each comes with API tokens alone, which have a
 * page of their own, and is kept out and removed as a person's is.
 */
export function ServiceAccountsPage() {
  const accounts = useAccountsQuery();
  const own = useAccountQuery();
  const create = useCreateAccountMutation();
  const disable = useDisableAccountMutation();
  const remove = useRemoveAccountMutation();
  const [confirming, setConfirming] = useState<{ doing: Confirming; account: Account }>();
  const confirmed = useLast(confirming);
  const done = { onSettled: () => setConfirming(undefined) };
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const services = accounts.data?.filter((account) => account.kind === "service");

  const select = (account: Account, doing: ServiceDoing) => {
    if (doing === "tokens") {
      void navigate({
        to: "/-/service-accounts/$accountId/tokens",
        params: { accountId: account.id },
      });
    } else if (doing === "enable") {
      disable.mutate({ id: account.id, disabled: false });
    } else {
      setConfirming({ doing, account });
    }
  };

  const confirm = ({ doing, account }: NonNullable<typeof confirming>) => {
    if (doing === "disable") {
      disable.mutate({ id: account.id, disabled: true }, done);
    } else {
      remove.mutate(account.id, done);
    }
  };

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
          No service accounts yet.
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
            {accounts.isPending ? <TableRowsSkeleton columns={4} actions twoLines /> : null}
            {services?.map((account) => {
              const actions = serviceActions(account, own.data?.id === account.id);
              const onSelect = (doing: ServiceDoing) => select(account, doing);
              return (
                <PersonContextMenu key={account.id} actions={actions} onSelect={onSelect}>
                  <TableRow
                    data-console-service={account.name}
                    data-console-service-state={account.disabledAt === null ? "in-use" : "disabled"}
                  >
                    <TableCell>
                      <AccountCell account={account} />
                    </TableCell>
                    <TableCell>
                      <span className="aperture:flex aperture:gap-1">
                        <Badge variant={account.admin ? "default" : "outline"}>
                          {account.admin ? "admin" : "service"}
                        </Badge>
                        {account.disabledAt === null ? null : (
                          <Badge variant="destructive">disabled</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell label="Created" className="aperture:text-muted-foreground">
                      {when.format(new Date(account.createdAt.epochMilliseconds))}
                    </TableCell>
                    <TableCell>
                      <div className="aperture:flex aperture:items-center aperture:justify-end aperture:gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          data-console-service-tokens
                          className="aperture:max-sm:hidden"
                          onClick={() => onSelect("tokens")}
                        >
                          <KeyRound />
                          API tokens
                        </Button>
                        <PersonActionsMenu
                          label="Service account actions"
                          actions={actions}
                          buttoned="tokens"
                          onSelect={onSelect}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                </PersonContextMenu>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={confirming !== undefined}
        title={
          confirmed === undefined ? "" : CONFIRM[confirmed.doing].title(confirmed.account.name)
        }
        description={confirmed === undefined ? "" : CONFIRM[confirmed.doing].description}
        confirmLabel={confirmed === undefined ? "" : CONFIRM[confirmed.doing].confirmLabel}
        variant="destructive"
        pending={disable.isPending || remove.isPending}
        onOpenChange={(open) => (open ? undefined : setConfirming(undefined))}
        onConfirm={() => (confirming === undefined ? undefined : confirm(confirming))}
      />
      <NameDialog
        title="New service account"
        open={creating}
        onOpenChange={setCreating}
        onSubmit={(name) => create.mutateAsync({ name })}
      />
    </TablePage>
  );
}
