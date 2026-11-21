import { Badge } from "@aperture-browser/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Link } from "@tanstack/react-router";
import { useNodesQuery } from "#/features/node/node.queries.ts";
import { told } from "#/lib/api.ts";

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
      <p
        data-console-empty
        className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
      >
        No node registered yet. Start an executor with a{" "}
        <Link to="/-/registration-tokens" className="aperture:underline">
          registration token
        </Link>{" "}
        and this control plane's address.
      </p>
    );
  }
  return (
    <div className="aperture:p-4">
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
    </div>
  );
}
