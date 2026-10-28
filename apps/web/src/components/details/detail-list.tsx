import { Children, isValidElement, type ReactNode } from "react";
import { cn } from "@aperture-browser/ui/utils";

type DetailListProps = {
  children: ReactNode;
  className?: string;
};

/** Vertical stack of detail sections. */
export function DetailList({ children, className }: DetailListProps) {
  return (
    <div className={cn("aperture:flex aperture:flex-col aperture:gap-4", className)}>
      {children}
    </div>
  );
}

type DetailSectionProps = {
  title?: string;
  children: ReactNode;
};

/**
 * A group of rows rendered as a two-column definition list. The section is
 * hidden entirely when every row in it is empty.
 */
export function DetailSection({ title, children }: DetailSectionProps) {
  const rows = Children.toArray(children).filter(
    (child) => !isValidElement<DetailRowProps>(child) || !isEmptyValue(child.props.children),
  );
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="aperture:flex aperture:flex-col aperture:gap-1.5">
      {title ? (
        <h3 className="aperture:text-xs aperture:font-medium aperture:text-muted-foreground">
          {title}
        </h3>
      ) : null}
      <dl className="aperture:grid aperture:grid-cols-[7rem_minmax(0,1fr)] aperture:items-baseline aperture:gap-x-4 aperture:gap-y-2 aperture:text-sm">
        {rows}
      </dl>
    </section>
  );
}

type DetailRowProps = {
  label: string;
  /** Rows whose value is `null`, `undefined`, `false` or an empty string are hidden. */
  children?: ReactNode;
};

export function DetailRow({ label, children }: DetailRowProps) {
  if (isEmptyValue(children)) {
    return null;
  }

  return (
    <div className="aperture:contents">
      <dt className="aperture:truncate aperture:text-muted-foreground">{label}</dt>
      <dd className="aperture:min-w-0 aperture:break-words">{children}</dd>
    </div>
  );
}

function isEmptyValue(value: ReactNode) {
  return value === null || value === undefined || value === false || value === "";
}
