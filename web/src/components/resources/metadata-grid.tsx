import type { ReactNode } from "react";
import { CopyButton } from "#/components/resources/copy-button.tsx";
import { Button } from "#/components/ui/button.tsx";
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
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <MetadataValue item={item} />
        </div>
      ))}
    </dl>
  );
}

function MetadataValue({ item }: { item: MetadataItem }) {
  switch (item.kind) {
    case "text":
      return <dd className="min-w-0 break-words text-sm">{item.value}</dd>;
    case "identifier":
      return (
        <dd className="flex min-w-0 items-center gap-1">
          {item.value === null || item.value === undefined ? (
            "—"
          ) : (
            <>
              <span className="min-w-0 break-all font-mono text-sm">{item.value}</span>
              <CopyButton
                value={item.value}
                label={`Copy ${item.label.toLowerCase()}`}
                className="shrink-0"
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
