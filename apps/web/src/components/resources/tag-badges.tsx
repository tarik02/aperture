import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Table, TableBody, TableCell, TableRow } from "@aperture-browser/ui/components/table";

type TagBadgesProps = {
  tags?: Record<string, string>;
  max?: number;
};

export function TagBadges({ tags, max = 3 }: TagBadgesProps) {
  if (!tags || Object.keys(tags).length === 0) {
    return <span className="aperture:text-muted-foreground">—</span>;
  }

  const entries = Object.entries(tags);
  const visible = entries.slice(0, max);
  const remaining = entries.length - visible.length;

  return (
    <ScrollArea scrollbars="horizontal" className="aperture:max-w-full aperture:min-w-0">
      <Table className="aperture:w-auto aperture:min-w-44 aperture:text-xs">
        <TableBody>
          {visible.map(([key, value]) => (
            <TableRow key={key} title={`${key}=${value}`} className="aperture:hover:bg-transparent">
              <TableCell className="aperture:max-w-32 aperture:border-r aperture:px-1.5 aperture:py-0.5 aperture:align-top aperture:font-medium aperture:text-muted-foreground">
                <span className="aperture:block aperture:truncate">{key}</span>
              </TableCell>
              <TableCell className="aperture:max-w-48 aperture:px-1.5 aperture:py-0.5 aperture:align-top aperture:font-mono">
                <span className="aperture:block aperture:truncate">{value}</span>
              </TableCell>
            </TableRow>
          ))}
          {remaining > 0 ? (
            <TableRow className="aperture:hover:bg-transparent">
              <TableCell
                colSpan={2}
                className="aperture:px-1.5 aperture:py-0.5 aperture:text-muted-foreground"
              >
                +{remaining} more
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
