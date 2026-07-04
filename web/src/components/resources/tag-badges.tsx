import { Badge } from "#/components/ui/badge.tsx";

type TagBadgesProps = {
  tags?: Record<string, string>;
  max?: number;
};

export function TagBadges({ tags, max = 3 }: TagBadgesProps) {
  if (!tags || Object.keys(tags).length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  const entries = Object.entries(tags);
  const visible = entries.slice(0, max);
  const remaining = entries.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(([key, value]) => (
        <Badge key={key} variant="secondary" className="font-normal">
          {key}={value}
        </Badge>
      ))}
      {remaining > 0 ? (
        <Badge variant="outline" className="font-normal">
          +{remaining}
        </Badge>
      ) : null}
    </div>
  );
}
