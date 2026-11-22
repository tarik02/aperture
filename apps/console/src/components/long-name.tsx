import { cn } from "@aperture-browser/ui/utils";

/**
 * What a row's cell tells in two lines, one below the other: as tall whichever lines it
 * has, so that the rows of every list that tells two are of one height.
 */
export const TWO_LINES =
  "aperture:grid aperture:content-center aperture:gap-0.5 aperture:sm:min-h-[2.625rem]";

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
