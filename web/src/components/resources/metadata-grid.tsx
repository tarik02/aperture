import { formatTimestamp } from "#/lib/format.ts";

type MetadataItem = {
  label: string;
  value: React.ReactNode;
};

type MetadataGridProps = {
  items: MetadataItem[];
};

export function MetadataGrid({ items }: MetadataGridProps) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-all font-mono text-xs">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function metadataTimestamp(value: string | null | undefined) {
  return formatTimestamp(value);
}
