import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { callAs, carry, told } from "#/lib/api.ts";
import { keepToken } from "#/lib/token.ts";

/** Signs in with an account's API token, until there is a login for people. */
export function SignInPage() {
  const [given, setGiven] = useState("");
  const signIn = useMutation({
    mutationFn: async (bearer: string) => {
      await callAs(bearer, (api) => api.accounts.current());
      await carry(bearer);
      return bearer;
    },
    onSuccess: keepToken,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate(given.trim());
  };

  return (
    <main className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:p-4">
      <form
        data-console-sign-in
        onSubmit={submit}
        className="aperture:flex aperture:w-full aperture:max-w-sm aperture:flex-col aperture:gap-3"
      >
        <h1 className="aperture:text-lg aperture:font-semibold">Aperture</h1>
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
        {signIn.isError ? (
          <p role="alert" className="aperture:text-sm aperture:text-destructive">
            {told(signIn.error)}
          </p>
        ) : null}
        <Button type="submit" disabled={given.trim() === "" || signIn.isPending}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
