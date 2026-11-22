import { Badge } from "@aperture-browser/ui/components/badge";
import type { Account } from "#/features/account/account.queries.ts";

/** What a person signs in with, each way a word. */
export function SignsInWith({ account }: { account: Account }) {
  const ways = account.signIn;
  const said =
    ways === null
      ? []
      : [
          ...(ways.password ? [{ key: "password", says: "Password" }] : []),
          ...(ways.secondFactor ? [{ key: "second-factor", says: "Two-factor" }] : []),
          ...(ways.passkeys > 0
            ? [
                {
                  key: "passkeys",
                  says: `${ways.passkeys} passkey${ways.passkeys === 1 ? "" : "s"}`,
                },
              ]
            : []),
          ...ways.providers.map((provider) => ({ key: `provider:${provider}`, says: provider })),
        ];
  if (said.length === 0) {
    return <span className="aperture:text-muted-foreground">Nothing yet</span>;
  }
  return (
    <span className="aperture:flex aperture:max-w-64 aperture:flex-wrap aperture:gap-1">
      {said.map((way) => (
        <Badge key={way.key} variant="secondary" data-console-sign-in-method={way.key}>
          {way.says}
        </Badge>
      ))}
    </span>
  );
}
