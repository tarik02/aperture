import { Tags } from "lucide-react";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@aperture-browser/ui/components/popover";
import { TagFilter } from "#/components/resources/tag-filter.tsx";
import type { TagFilterValue } from "#/lib/tag-filter.ts";

/** A toolbar button that filters a list by tags; it shows how many conditions apply. */
export function TagFilterButton({
  label,
  value,
  availableTags,
  onChange,
}: {
  label: string;
  value: TagFilterValue | undefined;
  availableTags: Array<Record<string, string>>;
  onChange: (value: TagFilterValue | undefined) => void;
}) {
  const count = value?.length ?? 0;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant={count > 0 ? "secondary" : "ghost"}
            size={count > 0 ? "default" : "icon"}
            aria-label={count > 0 ? `${label}: ${count} applied` : label}
            title={label}
          />
        }
      >
        <Tags />
        {count > 0 ? (
          <Badge variant="outline" className="aperture:h-4 aperture:px-1">
            {count}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="aperture:w-auto aperture:max-w-[min(32rem,calc(100vw-2rem))]"
      >
        <PopoverHeader className="aperture:flex-row aperture:items-center aperture:justify-between">
          <PopoverTitle>{label}</PopoverTitle>
          {count > 0 ? (
            <Button variant="ghost" size="xs" onClick={() => onChange(undefined)}>
              Clear
            </Button>
          ) : null}
        </PopoverHeader>
        {availableTags.some((tags) => Object.keys(tags).length > 0) || count > 0 ? (
          <TagFilter value={value} availableTags={availableTags} onChange={onChange} />
        ) : (
          <p className="aperture:text-sm aperture:text-muted-foreground">
            Nothing here has tags yet.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
