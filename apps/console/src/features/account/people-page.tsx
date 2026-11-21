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
import { Link2, Plus } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { AccountCell } from "#/features/account/account-cell.tsx";
import {
  useDisableAccountMutation,
  useRemoveAccountMutation,
  useRemovePasskeysMutation,
  useResetSecondFactorMutation,
  useSetupLinkMutation,
} from "#/features/account/account.mutations.ts";
import { type Account, useAccountsQuery } from "#/features/account/account.queries.ts";
import {
  PersonActionsMenu,
  PersonContextMenu,
  type PersonDoing,
  personActions,
} from "#/features/account/person-actions-menu.tsx";
import { PersonCreateDialog } from "#/features/account/person-create-dialog.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What is asked again before it is done to a person. */
type Confirming = Exclude<PersonDoing, "setup-link" | "enable">;

const CONFIRM: Record<
  Confirming,
  { title: (name: string) => string; description: string; confirmLabel: string }
> = {
  reset: {
    title: (name) => `Turn two-factor sign-in off for ${name}?`,
    description:
      "For someone who lost their authenticator and backup codes. Their password stays, and they turn it on again themselves.",
    confirmLabel: "Turn off",
  },
  passkeys: {
    title: (name) => `Remove the passkeys of ${name}?`,
    description:
      "For someone who lost what holds them. What else they sign in with stays, and they add passkeys again themselves.",
    confirmLabel: "Remove",
  },
  disable: {
    title: (name) => `Disable ${name}?`,
    description:
      "They are signed out and sign in no more, and their API tokens and connected apps stop working. What is theirs stays.",
    confirmLabel: "Disable",
  },
  delete: {
    title: (name) => `Delete ${name}?`,
    description:
      "Their API tokens, connected apps and places in workspaces go with them. This is not undone.",
    confirmLabel: "Delete",
  },
};

/** What a person signs in with, each way a word. */
function SignsInWith({ account }: { account: Account }) {
  const ways = account.signIn;
  const said =
    ways === null
      ? []
      : [
          ...(ways.password ? [{ key: "password", says: "Password" }] : []),
          ...(ways.secondFactor ? [{ key: "second-factor", says: "Two-factor" }] : []),
          ...(ways.passkeys > 0
            ? [
                {
                  key: "passkeys",
                  says: `${ways.passkeys} passkey${ways.passkeys === 1 ? "" : "s"}`,
                },
              ]
            : []),
          ...ways.providers.map((provider) => ({ key: `provider:${provider}`, says: provider })),
        ];
  if (said.length === 0) {
    return <span className="aperture:text-muted-foreground">Nothing yet</span>;
  }
  return (
    <span className="aperture:flex aperture:max-w-64 aperture:flex-wrap aperture:gap-1">
      {said.map((way) => (
        <Badge key={way.key} variant="secondary" data-console-sign-in-method={way.key}>
          {way.says}
        </Badge>
      ))}
    </span>
  );
}

/**
 * The people who sign in: what each signs in with, the way to a password and out of what
 * they lost, and the ways to keep them out and to remove them.
 */
export function PeoplePage() {
  const accounts = useAccountsQuery();
  const own = useAccountQuery();
  const setupLink = useSetupLinkMutation();
  const resetSecondFactor = useResetSecondFactorMutation();
  const removePasskeys = useRemovePasskeysMutation();
  const disable = useDisableAccountMutation();
  const remove = useRemoveAccountMutation();
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string>();
  const [confirming, setConfirming] = useState<{ doing: Confirming; account: Account }>();
  const confirmed = useLast(confirming);
  const people = accounts.data?.filter((account) => account.kind === "person");
  const done = { onSettled: () => setConfirming(undefined) };
  const pending =
    resetSecondFactor.isPending ||
    removePasskeys.isPending ||
    disable.isPending ||
    remove.isPending;

  const select = (account: Account, doing: PersonDoing) => {
    if (doing === "setup-link") {
      setupLink.mutate(account.id, { onSuccess: setLink });
    } else if (doing === "enable") {
      disable.mutate({ id: account.id, disabled: false });
    } else {
      setConfirming({ doing, account });
    }
  };

  const confirm = ({ doing, account }: NonNullable<typeof confirming>) => {
    if (doing === "reset") {
      resetSecondFactor.mutate(account.id, done);
    } else if (doing === "passkeys") {
      removePasskeys.mutate(account.id, done);
    } else if (doing === "disable") {
      disable.mutate({ id: account.id, disabled: true }, done);
    } else {
      remove.mutate(account.id, done);
    }
  };

  return (
    <TablePage>
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
          Nobody yet.
        </p>
      ) : (
        <Table stickyActionColumn>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Signs in with</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="aperture:w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {people?.map((account) => {
              const actions = personActions(account, own.data?.id === account.id);
              const onSelect = (doing: PersonDoing) => select(account, doing);
              return (
                <PersonContextMenu key={account.id} actions={actions} onSelect={onSelect}>
                  <TableRow
                    data-console-person={account.name}
                    data-console-person-state={account.disabledAt === null ? "in-use" : "disabled"}
                  >
                    <TableCell>
                      <AccountCell account={account} />
                    </TableCell>
                    <TableCell>
                      <span className="aperture:flex aperture:gap-1">
                        <Badge variant={account.admin ? "default" : "outline"}>
                          {account.admin ? "admin" : "member"}
                        </Badge>
                        {account.disabledAt === null ? null : (
                          <Badge variant="destructive">disabled</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <SignsInWith account={account} />
                    </TableCell>
                    <TableCell label="Created" className="aperture:text-muted-foreground">
                      {when.format(new Date(account.createdAt.epochMilliseconds))}
                    </TableCell>
                    <TableCell>
                      <div className="aperture:flex aperture:items-center aperture:justify-end aperture:gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          data-console-setup-link
                          className="aperture:max-sm:hidden"
                          disabled={setupLink.isPending}
                          onClick={() => onSelect("setup-link")}
                        >
                          <Link2 />
                          Setup link
                        </Button>
                        <PersonActionsMenu
                          actions={actions}
                          buttoned="setup-link"
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
        pending={pending}
        onOpenChange={(open) => (open ? undefined : setConfirming(undefined))}
        onConfirm={() => (confirming === undefined ? undefined : confirm(confirming))}
      />
      <PersonCreateDialog open={creating} onOpenChange={setCreating} />
      <SecretDialog title="Setup link" secret={link} onClose={() => setLink(undefined)} />
    </TablePage>
  );
}
