import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Table, TableBody, TableCell, TableRow } from "#/components/ui/table.tsx";

type TagBadgesProps = {
  tags?: Record<string, string>;
  max?: number;
};

export function TagBadges({ tags, max = 3 }: TagBadgesProps) {
  if (!tags || Object.keys(tags).length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  const entries = Object.entries(tags);
  const visible = entries.slice(0, max);
  const remaining = entries.length - visible.length;

  return (
    <ScrollArea scrollbars="horizontal" className="max-w-full min-w-0">
      <Table className="w-auto min-w-44 text-xs">
        <TableBody>
          {visible.map(([key, value]) => (
            <TableRow key={key} title={`${key}=${value}`} className="hover:bg-transparent">
              <TableCell className="max-w-32 border-r px-1.5 py-0.5 align-top font-medium text-muted-foreground">
                <span className="block truncate">{key}</span>
              </TableCell>
              <TableCell className="max-w-48 px-1.5 py-0.5 align-top font-mono">
                <span className="block truncate">{value}</span>
              </TableCell>
            </TableRow>
          ))}
          {remaining > 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2} className="px-1.5 py-0.5 text-muted-foreground">
                +{remaining} more
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
