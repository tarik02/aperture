import type { Account } from "#/features/account/account.queries.ts";

/** Who an account is, as a row tells it: the name, the address where there is one, and the id. */
export function AccountCell({ account }: { account: Account }) {
  return (
    <div className="aperture:grid aperture:gap-0.5">
      <span className="aperture:font-medium">{account.name}</span>
      {account.email === null ? null : (
        <span className="aperture:text-sm aperture:text-muted-foreground">{account.email}</span>
      )}
      <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
        {account.id}
      </span>
    </div>
  );
}
