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
import { Link } from "@tanstack/react-router";
import { Server, Ticket } from "lucide-react";
import { LongName } from "#/components/long-name.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useNodesQuery } from "#/features/node/node.queries.ts";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { ListEmpty } from "#/components/list-empty.tsx";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The nodes that registered: where sessions run. */
export function NodesPage() {
  const nodes = useNodesQuery();

  if (nodes.isError) {
    return (
      <p role="alert" className="aperture:p-4 aperture:text-sm aperture:text-destructive">
        {told(nodes.error)}
      </p>
    );
  }
  if (nodes.data?.length === 0) {
    return (
      <TablePage>
        <ListEmpty icon={Server} title="No nodes yet">
          <Button size="sm" variant="outline" render={<Link to="/-/registration-tokens" />}>
            <Ticket />
            Registration tokens
          </Button>
        </ListEmpty>
      </TablePage>
    );
  }
  return (
    <TablePage>
      <Table>
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
          {nodes.isPending ? <TableRowsSkeleton columns={5} /> : null}
          {nodes.data?.map((node) => (
            <TableRow key={node.id} data-console-node={node.name}>
              <TableCell className="aperture:font-medium">
                <LongName>{node.name}</LongName>
              </TableCell>
              <TableCell>
                <Badge variant={node.alive ? "default" : "destructive"}>
                  {node.alive ? "alive" : "silent"}
                </Badge>
              </TableCell>
              <TableCell className="aperture:font-mono aperture:text-xs">
                {node.internalUrl}
              </TableCell>
              <TableCell label="Version" className="aperture:text-muted-foreground">
                {node.offers?.version ?? "not reached yet"}
              </TableCell>
              <TableCell label="Last seen" className="aperture:text-muted-foreground">
                {when.format(new Date(node.lastSeenAt.epochMilliseconds))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TablePage>
  );
}
