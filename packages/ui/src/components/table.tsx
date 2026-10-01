import * as React from "react";

import { cn } from "../utils.ts";

const stickyTableStartHeaderClassName =
  "aperture:sticky aperture:left-[var(--table-scroll-padding-inline)] aperture:z-40 aperture:w-8 aperture:bg-background";
const stickyTableEndHeaderClassName =
  "aperture:sticky aperture:right-[var(--table-scroll-padding-inline)] aperture:z-40 aperture:w-10 aperture:bg-background";
const stickyTableStartCellClassName =
  "aperture:sticky aperture:left-[var(--table-scroll-padding-inline)] aperture:z-10 aperture:bg-background";
const stickyTableEndCellClassName =
  "aperture:sticky aperture:right-[var(--table-scroll-padding-inline)] aperture:z-10 aperture:bg-background";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="aperture:relative aperture:w-full">
      <table
        data-slot="table"
        className={cn(
          "aperture:w-full aperture:min-w-max aperture:caption-bottom aperture:text-sm",
          className,
        )}
        {...props}
      />
    </div>
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
  return (
    <th
      data-slot="table-head"
      className={cn(
        "aperture:sticky aperture:top-0 aperture:z-30 aperture:h-10 aperture:bg-background aperture:px-2 aperture:text-left aperture:align-middle aperture:font-medium aperture:whitespace-nowrap aperture:text-foreground aperture:[&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "aperture:p-2 aperture:align-middle aperture:whitespace-nowrap aperture:transition-colors aperture:[&:has([role=checkbox])]:pr-0",
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

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  stickyTableStartHeaderClassName,
  stickyTableEndHeaderClassName,
  stickyTableStartCellClassName,
  stickyTableEndCellClassName,
};
