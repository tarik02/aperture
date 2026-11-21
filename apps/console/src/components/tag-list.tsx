import { Badge } from "@aperture-browser/ui/components/badge";
import { cn } from "@aperture-browser/ui/utils";

type TagListProps = {
  tags: Readonly<Record<string, string>>;
  className?: string;
};

/** Tags as they are read: each name with what it is set to. */
export function TagList({ tags, className }: TagListProps) {
  const entries = Object.entries(tags);
  if (entries.length === 0) {
    return null;
  }
  return (
    <span className={cn("aperture:flex aperture:flex-wrap aperture:gap-1", className)}>
      {entries.map(([key, value]) => (
        <Badge key={key} variant="secondary" data-console-tag={`${key}=${value}`}>
          {value === "" ? key : `${key}: ${value}`}
        </Badge>
      ))}
    </span>
  );
}
