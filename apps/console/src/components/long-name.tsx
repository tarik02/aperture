import { cn } from "@aperture-browser/ui/utils";

/**
 * A name that may be longer than its row has room for: cut short in a table's column, with
 * the whole of it told on hover, and in full on a phone, where a row is as tall as it needs.
 */
export function LongName({ children, className }: { children: string; className?: string }) {
  return (
    <span
      title={children}
      className={cn(
        "aperture:block aperture:max-w-80 aperture:truncate aperture:max-sm:max-w-full aperture:max-sm:whitespace-normal aperture:max-sm:wrap-anywhere",
        className,
      )}
    >
      {children}
    </span>
  );
}
