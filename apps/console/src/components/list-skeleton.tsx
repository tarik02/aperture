import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { TableCell, TableRow } from "@aperture-browser/ui/components/table";
import { cn } from "@aperture-browser/ui/utils";

/** How wide what stands for a cell's text is, row after row: no two rows alike, as text is. */
const WIDTHS = [
  "aperture:w-40",
  "aperture:w-28",
  "aperture:w-48",
  "aperture:w-32",
  "aperture:w-36",
];

type TableRowsSkeletonProps = {
  /** How many columns the table has, the one of its rows' actions among them. */
  columns: number;
  /** Whether the last column holds what is done with a row, in place of something told. */
  actions?: boolean;
  /** Whether the first cell tells two things, one below the other. */
  twoLines?: boolean;
  rows?: number;
};

/**
 * The rows of a table before they are known, under the header they will have: each as
 * tall as a row is, so that what comes takes their place and nothing moves.
 */
export function TableRowsSkeleton({
  columns,
  actions = false,
  twoLines = false,
  rows = 5,
}: TableRowsSkeletonProps) {
  return Array.from({ length: rows }, (_, row) => (
    <TableRow key={row} aria-hidden data-console-skeleton className="aperture:hover:bg-transparent">
      {Array.from({ length: columns }, (_, column) => {
        const last = column === columns - 1;
        return (
          <TableCell key={column}>
            {actions && last ? (
              <Skeleton className="aperture:ml-auto aperture:h-7 aperture:w-16" />
            ) : column === 0 ? (
              <div className="aperture:grid aperture:gap-1.5">
                <Skeleton className={cn("aperture:h-5", WIDTHS[row % WIDTHS.length])} />
                {twoLines ? <Skeleton className="aperture:h-4 aperture:w-24" /> : null}
              </div>
            ) : (
              <Skeleton
                className={cn(
                  "aperture:h-5",
                  WIDTHS[(row + column) % WIDTHS.length],
                  "aperture:max-w-24",
                )}
              />
            )}
          </TableCell>
        );
      })}
    </TableRow>
  ));
}

/** The grid that cards stand in, as many beside each other as there is room for. */
export const CARD_GRID =
  "aperture:grid aperture:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] aperture:gap-4 aperture:max-sm:gap-3";

/**
 * Cards before what they show is known, each the shape a card has: what comes takes their
 * place and nothing moves.
 */
export function CardsSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div aria-hidden data-console-skeleton className={CARD_GRID}>
      {Array.from({ length: cards }, (_, card) => (
        <div
          key={card}
          className="aperture:relative aperture:aspect-[4/3] aperture:overflow-hidden aperture:rounded-xl aperture:bg-muted/60 aperture:ring-1 aperture:ring-foreground/10"
        >
          <Skeleton className="aperture:absolute aperture:top-2 aperture:left-2 aperture:h-5 aperture:w-16 aperture:rounded-full aperture:bg-foreground/10" />
          <div className="aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:grid aperture:gap-1.5 aperture:border-t aperture:border-foreground/10 aperture:bg-background/85 aperture:px-3 aperture:py-2.5">
            <Skeleton className={cn("aperture:h-4", WIDTHS[card % WIDTHS.length])} />
            <Skeleton className="aperture:h-3 aperture:w-44" />
            <Skeleton className="aperture:h-3 aperture:w-52" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * How tall a row of a list in a dialog is, as a CSS length: two lines of text or what is
 * pressed beside them, whichever is taller, and the room around them.
 */
export const ITEM_ROW = "(max(2.375rem, var(--control-height)) + 1.125rem)";

/** A line of a list's row that is told whole, in as many lines as it takes. */
export const WHOLE = "aperture:line-clamp-none aperture:w-auto aperture:wrap-anywhere";

/**
 * The lines of a list in a dialog before they are known, each with what it is called,
 * something below that and something at its end, as the lines that come have.
 */
export function LinesSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <ul aria-hidden data-console-skeleton className="aperture:grid aperture:gap-3">
      {Array.from({ length: lines }, (_, line) => (
        <li key={line} className="aperture:flex aperture:items-center aperture:gap-2">
          <span className="aperture:grid aperture:flex-1 aperture:gap-1.5">
            <Skeleton className={cn("aperture:h-4", WIDTHS[line % WIDTHS.length])} />
            <Skeleton className="aperture:h-3 aperture:w-52 aperture:max-w-full" />
          </span>
          <Skeleton className="aperture:h-6 aperture:w-16" />
        </li>
      ))}
    </ul>
  );
}
