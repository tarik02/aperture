import { LongName, TWO_LINES } from "#/components/long-name.tsx";
import type { Account } from "#/features/account/account.queries.ts";

/**
 * Who an account is, as a row tells it, in two lines: the name, and the address a person
 * signs in with or, for what has none, its id. A person's id is told where they are opened.
 */
export function AccountCell({ account }: { account: Account }) {
  return (
    <div className={TWO_LINES}>
      <LongName className="aperture:font-medium">{account.name}</LongName>
      {account.email === null ? (
        <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
          {account.id}
        </span>
      ) : (
        <LongName className="aperture:text-sm aperture:text-muted-foreground">
          {account.email}
        </LongName>
      )}
    </div>
  );
}
