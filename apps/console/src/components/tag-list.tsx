import { Badge } from "@aperture-browser/ui/components/badge";

/** Tags as they are read: each name with what it is set to. */
export function TagList({ tags }: { tags: Readonly<Record<string, string>> }) {
  const entries = Object.entries(tags);
  if (entries.length === 0) {
    return null;
  }
  return (
    <span className="aperture:flex aperture:flex-wrap aperture:gap-1">
      {entries.map(([key, value]) => (
        <Badge key={key} variant="secondary" data-console-tag={`${key}=${value}`}>
          {value === "" ? key : `${key}: ${value}`}
        </Badge>
      ))}
    </span>
  );
}
