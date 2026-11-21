import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { callAs, carry, told } from "#/lib/api.ts";
import { signIn } from "#/lib/identity.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import { keepToken } from "#/lib/token.ts";

/** Signs a person in with their password, or anyone with an account's API token. */
export function SignInPage() {
  const queries = useQueryClient();
  const [way, setWay] = useState<"password" | "token">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [given, setGiven] = useState("");

  const withPassword = useMutation({
    mutationFn: () => signIn(email.trim(), password),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.account }),
  });
  const withToken = useMutation({
    mutationFn: async (bearer: string) => {
      await callAs(bearer, (api) => api.accounts.current());
      await carry(bearer);
      return bearer;
    },
    onSuccess: keepToken,
  });
  const signing = way === "password" ? withPassword : withToken;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (way === "password") {
      withPassword.mutate();
    } else {
      withToken.mutate(given.trim());
    }
  };

  return (
    <main className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:p-4">
      <form
        data-console-sign-in={way}
        onSubmit={submit}
        className="aperture:flex aperture:w-full aperture:max-w-sm aperture:flex-col aperture:gap-3"
      >
        <h1 className="aperture:text-lg aperture:font-semibold">Aperture</h1>
        {way === "password" ? (
          <>
            <label className="aperture:flex aperture:flex-col aperture:gap-1.5 aperture:text-sm">
              Email
              <Input
                type="email"
                name="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="aperture:flex aperture:flex-col aperture:gap-1.5 aperture:text-sm">
              Password
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="aperture:flex aperture:flex-col aperture:gap-1.5 aperture:text-sm">
            API token
            <Input
              type="password"
              name="token"
              autoComplete="off"
              autoFocus
              placeholder="apc_…"
              value={given}
              onChange={(event) => setGiven(event.target.value)}
            />
          </label>
        )}
        {signing.isError ? (
          <p role="alert" className="aperture:text-sm aperture:text-destructive">
            {told(signing.error)}
          </p>
        ) : null}
        <Button type="submit" disabled={signing.isPending}>
          Sign in
        </Button>
        <Button
          type="button"
          variant="link"
          data-console-sign-in-way
          onClick={() => setWay(way === "password" ? "token" : "password")}
        >
          {way === "password" ? "Use an API token" : "Use a password"}
        </Button>
      </form>
    </main>
  );
}
