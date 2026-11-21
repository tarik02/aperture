import { Badge } from "@aperture-browser/ui/components/badge";
import { cn } from "@aperture-browser/ui/utils";

type TagListProps = {
  tags: Readonly<Record<string, string>>;
  className?: string;
  /** How many are shown where there is room for one line of them: the rest are counted. */
  most?: number;
};

/** Tags as they are read: each name with what it is set to. */
export function TagList({ tags, className, most }: TagListProps) {
  const entries = Object.entries(tags);
  if (entries.length === 0) {
    return null;
  }
  const says = ([key, value]: readonly [string, string]) =>
    value === "" ? key : `${key}: ${value}`;
  const shown = most === undefined ? entries : entries.slice(0, most);
  const more = entries.slice(shown.length);
  return (
    <span
      className={cn("aperture:flex aperture:min-w-0 aperture:flex-wrap aperture:gap-1", className)}
    >
      {shown.map((entry) => (
        <Badge
          key={entry[0]}
          variant="secondary"
          data-console-tag={`${entry[0]}=${entry[1]}`}
          title={says(entry)}
          // A long one is cut short where it stands among others, and never past its box.
          className="aperture:max-w-full aperture:min-w-0 aperture:shrink"
        >
          <span className="aperture:truncate">{says(entry)}</span>
        </Badge>
      ))}
      {more.length === 0 ? null : (
        <Badge variant="outline" title={more.map(says).join("\n")} className="aperture:shrink-0">
          +{more.length}
        </Badge>
      )}
    </span>
  );
}
