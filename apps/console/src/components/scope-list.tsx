import { Badge } from "@aperture-browser/ui/components/badge";

type ScopeListProps = {
  scopes: ReadonlyArray<string>;
  /** What each is marked with, for whoever looks for one: the scope is its value. */
  mark: "data-console-token-scope" | "data-console-grant-scope";
  /** How many are shown in the one line a row has: the rest are counted, and told on hover. */
  most?: number;
};

/** Scopes as a row tells them, in one line: each as it is written, since it is an identifier. */
export function ScopeList({ scopes, mark, most = 3 }: ScopeListProps) {
  const shown = scopes.slice(0, most);
  const more = scopes.slice(shown.length);
  return (
    <span className="aperture:flex aperture:gap-1 aperture:max-sm:flex-wrap">
      {shown.map((scope) => (
        <Badge key={scope} variant="secondary" {...{ [mark]: scope }}>
          {scope}
        </Badge>
      ))}
      {more.length === 0 ? null : (
        <Badge variant="outline" title={more.join("\n")}>
          +{more.length}
        </Badge>
      )}
    </span>
  );
}
