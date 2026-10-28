import { formatDistanceToNow } from "date-fns";
import { CopyButton } from "#/components/resources/copy-button.tsx";
import { Button } from "@aperture-browser/ui/components/button";
import { shortenId } from "#/components/details/id-chip.tsx";

type RelativeTimeProps = {
  value: string;
};

/** Relative time ("3 hours ago", "in 2 days") with the absolute time on hover. */
export function RelativeTime({ value }: RelativeTimeProps) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return <span>{value}</span>;
  }

  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {formatDistanceToNow(date, { addSuffix: true })}
    </time>
  );
}

/** A `RelativeTime`, or `null` so the surrounding row is hidden. */
export function relativeTime(value: string | null | undefined) {
  return value ? <RelativeTime value={value} /> : null;
}

type ReferenceValueProps = {
  id: string;
  name?: string | null;
  /** What the id points at, such as "User", shown muted before the name. */
  type?: string;
};

/** Something referred to by id: its name, with the id behind a copy button. */
export function ReferenceValue({ id, name, type }: ReferenceValueProps) {
  return (
    <span className="aperture:inline-flex aperture:max-w-full aperture:items-center aperture:gap-1.5 aperture:align-middle">
      {type ? (
        <span className="aperture:shrink-0 aperture:text-muted-foreground">{type}</span>
      ) : null}
      <span className={name ? "aperture:truncate" : "aperture:truncate aperture:font-mono"}>
        {name ?? shortenId(id)}
      </span>
      <CopyButton
        value={id}
        label={`Copy ID ${id}`}
        className="aperture:-my-1 aperture:shrink-0 aperture:text-muted-foreground"
        render={<Button variant="ghost" size="icon-xs" />}
      />
    </span>
  );
}

/** A `ReferenceValue`, or `null` so the surrounding row is hidden. */
export function reference(
  value: { id: string; name?: string | null } | null | undefined,
  type?: string,
) {
  return value ? <ReferenceValue id={value.id} name={value.name} type={type} /> : null;
}
