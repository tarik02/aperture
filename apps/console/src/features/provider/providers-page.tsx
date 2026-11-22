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
import { CircleCheck, CircleSlash, LogIn, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { LongName } from "#/components/long-name.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { ProviderDialog } from "#/features/provider/provider-dialog.tsx";
import {
  useEnableProviderMutation,
  useRemoveProviderMutation,
} from "#/features/provider/provider.mutations.ts";
import { type Provider, useProvidersQuery } from "#/features/provider/provider.queries.ts";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";
import { ListEmpty } from "#/components/list-empty.tsx";

/** The providers people sign in through beside their passwords and passkeys. */
export function ProvidersPage() {
  const providers = useProvidersQuery();
  const enable = useEnableProviderMutation();
  const remove = useRemoveProviderMutation();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Provider>();
  const edited = useLast(editing);
  const [removing, setRemoving] = useState<Provider>();
  const removed = useLast(removing);

  const listed = providers.data?.providers ?? [];
  const callbackBase = providers.data?.callbackBase ?? "";

  return (
    <TablePage>
      <PageHeaderActions>
        <Button
          data-console-provider-new
          size="sm"
          disabled={!providers.isSuccess}
          onClick={() => setAdding(true)}
        >
          <Plus />
          New provider
        </Button>
      </PageHeaderActions>
      {providers.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(providers.error)}
        </p>
      ) : providers.isSuccess && listed.length === 0 ? (
        <ListEmpty icon={LogIn} title="No sign-in providers yet">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            New provider
          </Button>
        </ListEmpty>
      ) : (
        <Table stickyActionColumn>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Issuer</TableHead>
              <TableHead>Creates people</TableHead>
              <TableHead className="aperture:w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.isPending ? <TableRowsSkeleton columns={6} actions /> : null}
            {listed.map((provider) => {
              // What the settings name is changed there, and nowhere on this page.
              const actions: ReadonlyArray<RowAction> =
                provider.source === "configuration"
                  ? []
                  : [
                      {
                        key: "edit",
                        label: "Edit",
                        icon: Pencil,
                        onSelect: () => setEditing(provider),
                      },
                      {
                        key: provider.enabled ? "disable" : "enable",
                        label: provider.enabled ? "Disable" : "Enable",
                        icon: provider.enabled ? CircleSlash : CircleCheck,
                        onSelect: () =>
                          enable.mutate({ id: provider.id, enabled: !provider.enabled }),
                      },
                      {
                        key: "remove",
                        label: "Remove",
                        icon: Trash2,
                        destructive: true,
                        parted: true,
                        onSelect: () => setRemoving(provider),
                      },
                    ];
              return (
                <RowContextMenu key={`${provider.source}:${provider.id}`} actions={actions}>
                  <TableRow data-console-provider={provider.id}>
                    <TableCell className="aperture:font-medium">
                      <LongName>{provider.name}</LongName>
                    </TableCell>
                    <TableCell>
                      <span className="aperture:flex aperture:flex-wrap aperture:gap-1">
                        <Badge
                          data-console-provider-state={provider.enabled ? "enabled" : "disabled"}
                          variant={provider.enabled ? "default" : "outline"}
                        >
                          {provider.enabled ? "enabled" : "disabled"}
                        </Badge>
                        {provider.source === "configuration" ? (
                          <Badge variant="secondary">from configuration</Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell label="ID" className="aperture:font-mono aperture:text-xs">
                      {provider.id}
                    </TableCell>
                    <TableCell label="Issuer" className="aperture:text-muted-foreground">
                      <LongName className="aperture:max-sm:inline">{provider.issuer}</LongName>
                    </TableCell>
                    <TableCell label="Creates people" className="aperture:text-muted-foreground">
                      {!provider.provision
                        ? "No"
                        : provider.domains.length === 0
                          ? "Anyone it vouches for"
                          : provider.domains.map((domain) => `@${domain}`).join(", ")}
                    </TableCell>
                    <TableCell>
                      <RowActions actions={actions} label="Provider actions" />
                    </TableCell>
                  </TableRow>
                </RowContextMenu>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ProviderDialog open={adding} onOpenChange={setAdding} callbackBase={callbackBase} />
      <ProviderDialog
        open={editing !== undefined}
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        provider={edited}
        callbackBase={callbackBase}
      />
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${removed?.name ?? "this provider"}?`}
        description="Nobody is removed. People who sign in only through it cannot until it is added again."
        confirmLabel="Remove"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={(open) => (open ? undefined : setRemoving(undefined))}
        onConfirm={() =>
          removing === undefined
            ? undefined
            : remove.mutate(removing.id, { onSettled: () => setRemoving(undefined) })
        }
      />
    </TablePage>
  );
}
