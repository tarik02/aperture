import * as React from "react";

import { ScrollArea } from "./scroll-area.tsx";
import { cn } from "../utils.ts";

type TableContextValue = {
  stickyHeader: boolean;
  stickyFirstColumn: boolean;
  stickyLastColumn: boolean;
  /** Whether a row is a block of its own on a phone, in place of a line of columns. */
  stacks: boolean;
};

/** A table that scrolls nowhere and stays a table on a phone. */
const PLAIN: TableContextValue = {
  stickyHeader: false,
  stickyFirstColumn: false,
  stickyLastColumn: false,
  stacks: false,
};

const TableContext = React.createContext<TableContextValue>(PLAIN);

type TableProps = React.ComponentProps<"table"> & {
  /** Classes for the scroll shell. Give it a height or max-height to scroll vertically. */
  containerClassName?: string;
  /** Keep the first column visible while scrolling horizontally. */
  stickyFirstColumn?: boolean;
  /** Keep the last column visible while scrolling horizontally. */
  stickyLastColumn?: boolean;
  /** Alias for `stickyLastColumn`, for tables whose last column holds row actions. */
  stickyActionColumn?: boolean;
  /** Keep the header visible while scrolling vertically. On by default. */
  stickyHeader?: boolean;
  /**
   * Wrap the table in a scroll area with edge shadows. Turn it off for small inline tables
   * that size to their content.
   */
  scrollable?: boolean;
};

/** How far from an edge the table is scrolled before the edge's shadow shows. */
const SCROLL_EDGE_EPSILON = 2;

// Only a scroll fades a shadow: where it stands follows the columns as they are measured, and
// one that shows once the rows come shows at once, rather than slide or fade in with them.
const shadowClassName =
  "aperture:pointer-events-none aperture:absolute aperture:z-35 aperture:opacity-0 aperture:in-data-scrolled:transition-opacity aperture:duration-120 aperture:ease-out aperture:from-foreground/12 aperture:to-transparent";

function Table({ scrollable = true, ...props }: TableProps) {
  if (scrollable) {
    return <ScrollingTable {...props} />;
  }

  // Sticky columns need a scroll container, so a plain table ignores them.
  const {
    className,
    containerClassName,
    stickyFirstColumn: _stickyFirstColumn,
    stickyLastColumn: _stickyLastColumn,
    stickyActionColumn: _stickyActionColumn,
    stickyHeader: _stickyHeader,
    ...tableProps
  } = props;
  return (
    // Its own, and not that of a table it stands within: a dialog opened from a row is in
    // that row's table as React has it, and is no row of it.
    <TableContext.Provider value={PLAIN}>
      <div
        data-slot="table-container"
        className={cn("aperture:relative aperture:w-full", containerClassName)}
      >
        <table
          data-slot="table"
          className={cn("aperture:w-full aperture:caption-bottom aperture:text-sm", className)}
          {...tableProps}
        />
      </div>
    </TableContext.Provider>
  );
}

function ScrollingTable({
  className,
  containerClassName,
  stickyFirstColumn = false,
  stickyLastColumn: stickyLastColumnProp = false,
  stickyActionColumn = false,
  stickyHeader = true,
  ...props
}: Omit<TableProps, "scrollable">) {
  const shellRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLTableElement>(null);
  const stickyLastColumn = stickyLastColumnProp || stickyActionColumn;
  const context = React.useMemo(
    () => ({ stickyHeader, stickyFirstColumn, stickyLastColumn, stacks: true }),
    [stickyHeader, stickyFirstColumn, stickyLastColumn],
  );

  // Shadows sit outside the scrolled content, so they need the sticky geometry as variables.
  React.useLayoutEffect(() => {
    const shell = shellRef.current;
    const table = contentRef.current;
    if (!shell || !table) {
      return;
    }

    const updateGeometry = () => {
      const header = table.tHead;
      const headerCells = header?.rows[0]?.cells;
      const firstCell = headerCells?.[0];
      const lastCell = headerCells?.[headerCells.length - 1];
      shell.style.setProperty(
        "--table-header-height",
        `${stickyHeader ? (header?.offsetHeight ?? 0) : 0}px`,
      );
      shell.style.setProperty(
        "--table-sticky-start-width",
        `${stickyFirstColumn ? (firstCell?.offsetWidth ?? 0) : 0}px`,
      );
      shell.style.setProperty(
        "--table-sticky-end-width",
        `${stickyLastColumn ? (lastCell?.offsetWidth ?? 0) : 0}px`,
      );
    };

    updateGeometry();
    // Observing the table also covers header rows and cells that mount after the first render.
    const resizeObserver = new ResizeObserver(updateGeometry);
    resizeObserver.observe(table);
    if (table.tHead) {
      resizeObserver.observe(table.tHead);
    }
    const scrolled = () => {
      shell.dataset.scrolled = "";
    };
    // A scroll does not bubble, and is heard on its way down to the viewport instead.
    shell.addEventListener("scroll", scrolled, { capture: true, once: true });
    return () => {
      resizeObserver.disconnect();
      shell.removeEventListener("scroll", scrolled, { capture: true });
    };
  }, [contentRef, shellRef, stickyHeader, stickyFirstColumn, stickyLastColumn]);

  return (
    <TableContext.Provider value={context}>
      <div
        ref={shellRef}
        data-slot="table-container"
        className={cn(
          "aperture:relative aperture:flex aperture:min-h-0 aperture:w-full aperture:max-w-full aperture:flex-col aperture:overflow-hidden aperture:rounded-lg aperture:border aperture:[--table-header-height:0px] aperture:[--table-sticky-end-width:0px] aperture:[--table-sticky-start-width:0px]",
          containerClassName,
        )}
      >
        {/* The shadows after it show by what it says of itself: which edges it is scrolled from. */}
        <ScrollArea
          scrollbars="both"
          overflowEdgeThreshold={SCROLL_EDGE_EPSILON}
          className="aperture:min-h-0 aperture:w-full aperture:max-h-[inherit] aperture:flex-1 aperture:[&>[data-slot=scroll-area-scrollbar]]:z-50"
          viewportClassName="aperture:max-h-[inherit]"
        >
          <table
            ref={contentRef}
            data-slot="table"
            data-sticky-header={stickyHeader || undefined}
            data-sticky-first-column={stickyFirstColumn || undefined}
            data-sticky-last-column={stickyLastColumn || undefined}
            className={cn(
              "aperture:w-full aperture:min-w-max aperture:caption-bottom aperture:text-sm",
              // On a phone a row is a block of its own: what it is, then the rest in lines.
              "aperture:max-sm:block aperture:max-sm:min-w-0",
              className,
            )}
            {...props}
          />
        </ScrollArea>
        {stickyHeader ? (
          <div
            aria-hidden="true"
            className={cn(
              shadowClassName,
              "aperture:top-(--table-header-height) aperture:right-0 aperture:left-0 aperture:h-3 aperture:bg-linear-to-b aperture:[[data-overflow-y-start]~&]:opacity-100 aperture:[[data-overflow-x-start]~&]:left-(--table-sticky-start-width) aperture:[[data-overflow-x-end]~&]:right-(--table-sticky-end-width)",
            )}
          />
        ) : null}
        {stickyFirstColumn ? (
          <div
            aria-hidden="true"
            className={cn(
              shadowClassName,
              "aperture:top-0 aperture:bottom-0 aperture:left-(--table-sticky-start-width) aperture:w-4 aperture:bg-linear-to-r aperture:[[data-overflow-x-start]~&]:opacity-100 aperture:[[data-overflow-y-start]~&]:top-(--table-header-height)",
            )}
          />
        ) : null}
        {stickyLastColumn ? (
          <div
            aria-hidden="true"
            className={cn(
              shadowClassName,
              "aperture:top-0 aperture:right-(--table-sticky-end-width) aperture:bottom-0 aperture:w-4 aperture:bg-linear-to-l aperture:[[data-overflow-x-end]~&]:opacity-100 aperture:[[data-overflow-y-start]~&]:top-(--table-header-height)",
            )}
          />
        ) : null}
      </div>
    </TableContext.Provider>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  const { stacks } = React.useContext(TableContext);
  return (
    <thead
      data-slot="table-header"
      className={cn("aperture:[&_tr]:border-b", stacks && "aperture:max-sm:hidden", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  const { stacks } = React.useContext(TableContext);
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        "aperture:[&_tr:last-child]:border-0",
        stacks && "aperture:max-sm:block",
        className,
      )}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "aperture:border-t aperture:bg-muted/50 aperture:font-medium aperture:[&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  const { stacks } = React.useContext(TableContext);
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "aperture:group/table-row aperture:border-b aperture:sm:[&:has([aria-expanded=true])>td]:bg-muted/50 aperture:sm:[&:hover>td]:bg-[color-mix(in_oklch,var(--background),var(--muted)_50%)] aperture:sm:data-[state=selected]:[&>td]:bg-muted aperture:sm:data-[state=selected]:[&:hover>td]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)]",
        stacks &&
          "aperture:max-sm:relative aperture:max-sm:flex aperture:max-sm:flex-wrap aperture:max-sm:items-center aperture:max-sm:gap-x-3 aperture:max-sm:gap-y-1.5 aperture:max-sm:px-3 aperture:max-sm:py-3",
        // Room for the row's menu, which stands at its corner.
        stacks && "aperture:max-sm:in-data-sticky-last-column:pr-12",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const { stickyHeader, stickyFirstColumn, stickyLastColumn } = React.useContext(TableContext);

  return (
    <th
      data-slot="table-head"
      className={cn(
        "aperture:h-10 aperture:bg-muted aperture:px-2 aperture:text-left aperture:align-middle aperture:font-medium aperture:whitespace-nowrap aperture:text-foreground aperture:[&:has([role=checkbox])]:pr-0",
        stickyHeader && "aperture:sticky aperture:top-0 aperture:z-20",
        stickyFirstColumn &&
          "aperture:first:sticky aperture:first:left-0 aperture:first:z-40 aperture:first:border-r aperture:first:border-border",
        stickyLastColumn &&
          "aperture:last:sticky aperture:last:right-0 aperture:last:z-40 aperture:last:border-l aperture:last:border-border",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({
  className,
  label,
  ...props
}: React.ComponentProps<"td"> & {
  /** What the cell tells, said before it on a phone, where no header stands above it. */
  label?: string;
}) {
  const { stickyFirstColumn, stickyLastColumn, stacks } = React.useContext(TableContext);

  return (
    <td
      data-slot="table-cell"
      data-label={label}
      className={cn(
        // As tall as a row whose last cell has a button, whether or not this row has one: the
        // rows of a list are of one height, and those that tell two lines of another.
        "aperture:p-2 aperture:align-middle aperture:whitespace-nowrap aperture:transition-colors aperture:sm:h-11 aperture:[&:has([role=checkbox])]:pr-0",
        stacks &&
          "aperture:max-sm:block aperture:max-sm:max-w-full aperture:max-sm:min-w-0 aperture:max-sm:p-0 aperture:max-sm:whitespace-normal aperture:max-sm:wrap-anywhere aperture:max-sm:first:basis-full aperture:max-sm:empty:hidden aperture:max-sm:data-label:before:mr-1 aperture:max-sm:data-label:before:text-muted-foreground aperture:max-sm:data-label:before:content-[attr(data-label)]",
        stickyFirstColumn &&
          "aperture:sm:first:sticky aperture:sm:first:left-0 aperture:sm:first:z-10 aperture:sm:first:border-r aperture:sm:first:border-border aperture:sm:first:bg-background",
        stickyLastColumn &&
          "aperture:sm:last:sticky aperture:sm:last:right-0 aperture:sm:last:z-10 aperture:sm:last:border-l aperture:sm:last:border-border aperture:sm:last:bg-background aperture:max-sm:last:absolute aperture:max-sm:last:top-1.5 aperture:max-sm:last:right-1.5",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("aperture:mt-4 aperture:text-sm aperture:text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
