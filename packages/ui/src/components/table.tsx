import * as React from "react";

import { ScrollArea } from "./scroll-area.tsx";
import { cn } from "../utils.ts";

type TableContextValue = {
  stickyFirstColumn: boolean;
  stickyLastColumn: boolean;
};

const TableContext = React.createContext<TableContextValue>({
  stickyFirstColumn: false,
  stickyLastColumn: false,
});

type TableProps = React.ComponentProps<"table"> & {
  /** Classes for the scroll shell. Give it a height or max-height to scroll vertically. */
  containerClassName?: string;
  /** Keep the first column visible while scrolling horizontally. */
  stickyFirstColumn?: boolean;
  /** Keep the last column visible while scrolling horizontally. */
  stickyLastColumn?: boolean;
};

const SCROLL_EDGE_EPSILON = 2;

type ScrollBoundaries = {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
};

function readScrollBoundaries(viewport: HTMLElement): ScrollBoundaries {
  return {
    top: viewport.scrollTop > SCROLL_EDGE_EPSILON,
    right: viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > SCROLL_EDGE_EPSILON,
    bottom:
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > SCROLL_EDGE_EPSILON,
    left: viewport.scrollLeft > SCROLL_EDGE_EPSILON,
  };
}

/**
 * Mirrors which edges the viewport can still scroll towards into `data-can-scroll-*`
 * attributes on the shell, so shadows react to scrolling without re-rendering React.
 */
function useScrollBoundaries<Content extends HTMLElement>() {
  const shellRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<Content>(null);

  React.useLayoutEffect(() => {
    const shell = shellRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!shell || !viewport || !content) {
      return;
    }

    let animationFrame: number | null = null;
    let previous: ScrollBoundaries | null = null;

    const update = () => {
      animationFrame = null;
      const next = readScrollBoundaries(viewport);
      if (
        previous?.top === next.top &&
        previous.right === next.right &&
        previous.bottom === next.bottom &&
        previous.left === next.left
      ) {
        return;
      }
      shell.dataset.canScrollTop = String(next.top);
      shell.dataset.canScrollRight = String(next.right);
      shell.dataset.canScrollBottom = String(next.bottom);
      shell.dataset.canScrollLeft = String(next.left);
      previous = next;
    };
    const scheduleUpdate = () => {
      animationFrame ??= requestAnimationFrame(update);
    };

    scheduleUpdate();
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    viewport.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", scheduleUpdate);
    };
  }, []);

  return { shellRef, viewportRef, contentRef };
}

const shadowClassName =
  "aperture:pointer-events-none aperture:absolute aperture:z-35 aperture:opacity-0 aperture:transition-[opacity,left,right,top] aperture:duration-120 aperture:ease-out aperture:from-foreground/10 aperture:to-transparent";

function Table({
  className,
  containerClassName,
  stickyFirstColumn = false,
  stickyLastColumn = false,
  ...props
}: TableProps) {
  const { shellRef, viewportRef, contentRef } = useScrollBoundaries<HTMLTableElement>();
  const context = React.useMemo(
    () => ({ stickyFirstColumn, stickyLastColumn }),
    [stickyFirstColumn, stickyLastColumn],
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
      shell.style.setProperty("--table-header-height", `${header?.offsetHeight ?? 0}px`);
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
    return () => resizeObserver.disconnect();
  }, [contentRef, shellRef, stickyFirstColumn, stickyLastColumn]);

  return (
    <TableContext.Provider value={context}>
      <div
        ref={shellRef}
        data-slot="table-container"
        data-can-scroll-top="false"
        data-can-scroll-right="false"
        data-can-scroll-bottom="false"
        data-can-scroll-left="false"
        className={cn(
          "aperture:group/table aperture:relative aperture:flex aperture:min-h-0 aperture:w-full aperture:max-w-full aperture:flex-col aperture:overflow-hidden aperture:[--table-header-height:0px] aperture:[--table-sticky-end-width:0px] aperture:[--table-sticky-start-width:0px]",
          containerClassName,
        )}
      >
        <ScrollArea
          viewportRef={viewportRef}
          scrollbars="both"
          className="aperture:min-h-0 aperture:w-full aperture:max-h-[inherit] aperture:flex-1 aperture:[&>[data-slot=scroll-area-scrollbar]]:z-50"
          viewportClassName="aperture:max-h-[inherit]"
        >
          <table
            ref={contentRef}
            data-slot="table"
            className={cn(
              "aperture:w-full aperture:min-w-max aperture:caption-bottom aperture:text-sm",
              className,
            )}
            {...props}
          />
        </ScrollArea>
        <div
          aria-hidden="true"
          className={cn(
            shadowClassName,
            "aperture:top-(--table-header-height) aperture:right-0 aperture:left-0 aperture:h-3 aperture:bg-linear-to-b aperture:group-data-[can-scroll-top=true]/table:opacity-100 aperture:group-data-[can-scroll-left=true]/table:left-(--table-sticky-start-width) aperture:group-data-[can-scroll-right=true]/table:right-(--table-sticky-end-width)",
          )}
        />
        {stickyFirstColumn ? (
          <div
            aria-hidden="true"
            className={cn(
              shadowClassName,
              "aperture:top-0 aperture:bottom-0 aperture:left-(--table-sticky-start-width) aperture:w-4 aperture:bg-linear-to-r aperture:group-data-[can-scroll-left=true]/table:opacity-100 aperture:group-data-[can-scroll-top=true]/table:top-(--table-header-height)",
            )}
          />
        ) : null}
        {stickyLastColumn ? (
          <div
            aria-hidden="true"
            className={cn(
              shadowClassName,
              "aperture:top-0 aperture:right-(--table-sticky-end-width) aperture:bottom-0 aperture:w-4 aperture:bg-linear-to-l aperture:group-data-[can-scroll-right=true]/table:opacity-100 aperture:group-data-[can-scroll-top=true]/table:top-(--table-header-height)",
            )}
          />
        ) : null}
      </div>
    </TableContext.Provider>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("aperture:[&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("aperture:[&_tr:last-child]:border-0", className)}
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
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "aperture:border-b aperture:transition-colors aperture:[&:has([aria-expanded=true])>td]:bg-muted aperture:[&:hover>td]:bg-muted aperture:data-[state=selected]:[&>td]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const { stickyFirstColumn, stickyLastColumn } = React.useContext(TableContext);

  return (
    <th
      data-slot="table-head"
      className={cn(
        "aperture:sticky aperture:top-0 aperture:z-30 aperture:h-10 aperture:bg-background aperture:px-2 aperture:text-left aperture:align-middle aperture:font-medium aperture:whitespace-nowrap aperture:text-foreground aperture:[&:has([role=checkbox])]:pr-0",
        stickyFirstColumn && "aperture:first:left-0 aperture:first:z-40",
        stickyLastColumn && "aperture:last:right-0 aperture:last:z-40",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  const { stickyFirstColumn, stickyLastColumn } = React.useContext(TableContext);

  return (
    <td
      data-slot="table-cell"
      className={cn(
        "aperture:p-2 aperture:align-middle aperture:whitespace-nowrap aperture:transition-colors aperture:[&:has([role=checkbox])]:pr-0",
        stickyFirstColumn &&
          "aperture:first:sticky aperture:first:left-0 aperture:first:z-10 aperture:first:bg-background",
        stickyLastColumn &&
          "aperture:last:sticky aperture:last:right-0 aperture:last:z-10 aperture:last:bg-background",
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
