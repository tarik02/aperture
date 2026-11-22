import { Badge } from "@aperture-browser/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Blocks, Unplug } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { LongName } from "#/components/long-name.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useRevokeGrantMutation } from "#/features/oauth/oauth.mutations.ts";
import { type Grant, useGrantsQuery } from "#/features/oauth/oauth.queries.ts";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";
import { ListEmpty } from "#/components/list-empty.tsx";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const HELD_TO = [
  ["workspaces", "workspace"],
  ["sessions", "session"],
  ["snapshots", "snapshot"],
] as const;

/** What a grant reaches: all its account does, or how many of each thing it is held to. */
function Reach({ resources }: { resources: Grant["resources"] }) {
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
          title={resources[kind].join("\n")}
        >
          {resources[kind].length} {one}
          {resources[kind].length === 1 ? "" : "s"}
        </Badge>
      ))}
    </span>
  );
}

/** The apps the account that is signed in let act as it, each to be taken back. */
export function ConnectedAppsPage() {
  const grants = useGrantsQuery();
  const revoke = useRevokeGrantMutation();
  const [revoking, setRevoking] = useState<Grant>();
  const revoked = useLast(revoking);

  return (
    <TablePage>
      {grants.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(grants.error)}
        </p>
      ) : grants.data?.length === 0 ? (
        <ListEmpty icon={Blocks} title="No connected apps yet" />
      ) : (
        <Table stickyActionColumn>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Resources</TableHead>
              <TableHead>Connected</TableHead>
              <TableHead className="aperture:w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.isPending ? <TableRowsSkeleton columns={5} actions /> : null}
            {(grants.data ?? []).map((grant) => {
              const actions: ReadonlyArray<RowAction> = [
                {
                  key: "disconnect",
                  label: "Disconnect",
                  icon: Unplug,
                  destructive: true,
                  shown: "button",
                  onSelect: () => setRevoking(grant),
                },
              ];
              return (
                <RowContextMenu key={grant.id} actions={actions}>
                  <TableRow data-console-grant={grant.clientName}>
                    <TableCell className="aperture:font-medium">
                      <LongName>{grant.clientName}</LongName>
                    </TableCell>
                    <TableCell>
                      <span className="aperture:flex aperture:max-w-64 aperture:flex-wrap aperture:gap-1">
                        {grant.scopes.map((scope) => (
                          <Badge key={scope} variant="secondary" data-console-grant-scope={scope}>
                            {scope}
                          </Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Reach resources={grant.resources} />
                    </TableCell>
                    <TableCell label="Connected" className="aperture:text-muted-foreground">
                      {when.format(new Date(grant.createdAt.epochMilliseconds))}
                    </TableCell>
                    <TableCell>
                      <RowActions actions={actions} label="App actions" />
                    </TableCell>
                  </TableRow>
                </RowContextMenu>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={revoking !== undefined}
        title={`Disconnect ${revoked?.clientName ?? "this app"}?`}
        description="It is let in no more until someone connects it again."
        confirmLabel="Disconnect"
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
