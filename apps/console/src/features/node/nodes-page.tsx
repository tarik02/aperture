import { Badge } from "@aperture-browser/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { useState } from "react";
import { NameForm } from "#/components/name-form.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import {
  useCreateRegistrationTokenMutation,
  useNodesQuery,
  useRegistrationTokensQuery,
} from "#/features/node/node.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The nodes that registered, and the tokens that let nodes register. */
export function NodesPage() {
  const nodes = useNodesQuery();
  const tokens = useRegistrationTokensQuery();
  const create = useCreateRegistrationTokenMutation();
  const [secret, setSecret] = useState<string>();

  return (
    <div className="aperture:flex aperture:flex-col aperture:gap-8 aperture:p-4">
      <section className="aperture:grid aperture:gap-3">
        <h2 className="aperture:text-sm aperture:font-semibold">Nodes</h2>
        {nodes.data?.length === 0 ? (
          <p className="aperture:text-sm aperture:text-muted-foreground">
            No node registered yet. Start an executor with a registration token and this control
            plane's address.
          </p>
        ) : (
          <Table scrollable={false}>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.data?.map((node) => (
                <TableRow key={node.id} data-console-node={node.name}>
                  <TableCell className="aperture:font-medium">{node.name}</TableCell>
                  <TableCell>
                    <Badge variant={node.alive ? "default" : "destructive"}>
                      {node.alive ? "alive" : "silent"}
                    </Badge>
                  </TableCell>
                  <TableCell className="aperture:font-mono aperture:text-xs">
                    {node.internalUrl}
                  </TableCell>
                  <TableCell className="aperture:text-muted-foreground">
                    {node.offers?.version ?? "not reached yet"}
                  </TableCell>
                  <TableCell className="aperture:text-muted-foreground">
                    {when.format(new Date(node.lastSeenAt.epochMilliseconds))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="aperture:grid aperture:gap-3">
        <div className="aperture:flex aperture:items-center aperture:gap-2">
          <h2 className="aperture:flex-1 aperture:text-sm aperture:font-semibold">
            Registration tokens
          </h2>
          <NameForm
            placeholder="Token name"
            label="New token"
            pending={create.isPending}
            onSubmit={(name) => create.mutate(name, { onSuccess: (made) => setSecret(made.token) })}
          />
        </div>
        <Table scrollable={false}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.data?.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="aperture:font-medium">{token.name}</TableCell>
                <TableCell className="aperture:text-muted-foreground">
                  {when.format(new Date(token.createdAt.epochMilliseconds))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <SecretDialog
        title="Registration token"
        secret={secret}
        onClose={() => setSecret(undefined)}
      />
    </div>
  );
}
