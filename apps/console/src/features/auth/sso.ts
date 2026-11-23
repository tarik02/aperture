import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { identity } from "#/lib/identity.ts";

/** The providers people sign in through, which anyone is told. */
export function useProvidersQuery() {
  return useQuery({
    queryKey: ["sign-in", "providers"],
    queryFn: () => call((api) => api.signIn.providers()),
    staleTime: Infinity,
  });
}

/** What a provider's refusal comes back as, in the address of the page that asked. */
const REFUSAL = ["error", "error_description"];

/** This page's address without what a refusal left in it. */
const here = () => {
  const url = new URL(location.href);
  for (const name of REFUSAL) {
    url.searchParams.delete(name);
  }
  return `${url.pathname}${url.search}`;
};

/**
 * Sends the browser to a provider, which sends it back to this page: signed in, or with
 * why not in the address.
 */
export const continueWith = async (provider: string) => {
  const { data } = await identity.signIn.social({
    provider,
    callbackURL: here(),
    errorCallbackURL: here(),
    disableRedirect: true,
  });
  if (data?.url === undefined) {
    throw new Error("The provider is not reached. Try again in a moment.");
  }
  location.assign(data.url);
};

const REFUSALS: Readonly<Record<string, string>> = {
  signup_disabled: "No account here goes with that email address. Ask an admin for one.",
  account_not_linked: "The provider does not say that your email address is verified.",
  email_not_verified: "The provider does not say that your email address is verified.",
  email_domain_refused: "Accounts are not made for email addresses of that domain.",
  email_not_found: "The provider did not tell your email address.",
  access_denied: "Signing in was called off at the provider.",
  account_disabled: "This account is disabled. Ask an admin.",
};

/** Why a provider signed nobody in, where this page's address says it did not; and the address without. */
export const refusal = () => {
  const code = new URLSearchParams(location.search).get("error");
  return code === null
    ? undefined
    : { message: REFUSALS[code] ?? `Signing in did not go through: ${code}`, without: here() };
};
