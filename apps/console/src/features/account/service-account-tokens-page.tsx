import { usePageCrumb } from "#/components/page-crumb.tsx";
import { useAccountsQuery } from "#/features/account/account.queries.ts";
import { TokensPage } from "#/features/token/tokens-page.tsx";
import { told } from "#/lib/api.ts";

/** The API tokens of one service account, as an admin sees and takes them back. */
export function ServiceAccountTokensPage({ accountId }: { accountId: string }) {
  const accounts = useAccountsQuery();
  const account = accounts.data?.find((one) => one.id === accountId && one.kind === "service");
  usePageCrumb(account?.name);

  if (account !== undefined || accounts.isPending) {
    return <TokensPage account={account} waiting={account === undefined} />;
  }
  return (
    <p
      role="alert"
      data-console-empty
      className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
    >
      {accounts.isError ? told(accounts.error) : "There is no such service account."}
    </p>
  );
}
