import type { ReactNode } from "react";
import { CopyButton } from "#/components/resources/copy-button.tsx";
import { Button } from "@aperture-browser/ui/components/button";
import { formatTimestamp } from "#/lib/format.ts";

type MetadataItem =
  | {
      kind: "text";
      label: string;
      value: ReactNode;
    }
  | {
      kind: "identifier";
      label: string;
      value: string | null | undefined;
    };

type MetadataGridProps = {
  items: MetadataItem[];
};

export function MetadataGrid({ items }: MetadataGridProps) {
  return (
    <dl className="aperture:grid aperture:grid-cols-[auto_minmax(0,1fr)] aperture:items-center aperture:gap-x-3 aperture:gap-y-1.5 aperture:text-sm">
      {items.map((item) => (
        <div key={item.label} className="aperture:contents">
          <dt className="aperture:text-muted-foreground">{item.label}</dt>
          <MetadataValue item={item} />
        </div>
      ))}
    </dl>
  );
}

function MetadataValue({ item }: { item: MetadataItem }) {
  switch (item.kind) {
    case "text":
      return (
        <dd className="aperture:min-w-0 aperture:break-words aperture:text-sm">{item.value}</dd>
      );
    case "identifier":
      return (
        <dd className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1">
          {item.value === null || item.value === undefined ? (
            "—"
          ) : (
            <>
              <span className="aperture:min-w-0 aperture:break-all aperture:font-mono aperture:text-sm">
                {item.value}
              </span>
              <CopyButton
                value={item.value}
                label={`Copy ${item.label.toLowerCase()}`}
                className="aperture:shrink-0"
                render={<Button variant="ghost" size="icon-xs" />}
              />
            </>
          )}
        </dd>
      );
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

export function metadataTimestamp(value: string | null | undefined) {
  return formatTimestamp(value);
}
