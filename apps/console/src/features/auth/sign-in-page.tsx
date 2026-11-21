import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { callAs, carry, told } from "#/lib/api.ts";
import { CodeInput } from "#/components/code-input.tsx";
import { giveBackupCode, giveCode, signIn } from "#/lib/identity.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import { keepToken } from "#/lib/token.ts";

/**
 * Signs a person in with their password, and a code where they turned a second factor on, or
 * anyone with an account's API token.
 */
export function SignInPage() {
  const queries = useQueryClient();
  const [way, setWay] = useState<"password" | "token" | "code" | "backup-code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [given, setGiven] = useState("");
  const [code, setCode] = useState("");

  const signedIn = () =>
    Promise.all([
      queries.invalidateQueries({ queryKey: queryKeys.account }),
      queries.invalidateQueries({ queryKey: queryKeys.person }),
    ]);
  const withPassword = useMutation({
    mutationFn: () => signIn(email.trim(), password),
    onSuccess: (answer) => {
      if (answer === "signed-in") {
        return signedIn();
      }
      setCode("");
      setWay("code");
    },
  });
  const withCode = useMutation({
    mutationFn: (given: string) =>
      (way === "backup-code" ? giveBackupCode : giveCode)(given.trim()),
    // A code that was not taken is typed anew.
    onError: () => setCode(""),
    onSuccess: signedIn,
  });
  const withToken = useMutation({
    mutationFn: async (bearer: string) => {
      await callAs(bearer, (api) => api.accounts.current());
      await carry(bearer);
      return bearer;
    },
    onSuccess: keepToken,
  });
  const second = way === "code" || way === "backup-code";
  const signing = second ? withCode : way === "password" ? withPassword : withToken;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (second) {
      withCode.mutate(code);
    } else if (way === "password") {
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
        {way === "code" ? (
          <CodeInput
            value={code}
            onChange={setCode}
            onComplete={(given) => (withCode.isPending ? undefined : withCode.mutate(given))}
          />
        ) : way === "backup-code" ? (
          <label className="aperture:flex aperture:flex-col aperture:gap-1.5 aperture:text-sm">
            Backup code
            <Input
              name="code"
              autoComplete="off"
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        ) : way === "password" ? (
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
        {second ? (
          <>
            <Button
              type="button"
              variant="link"
              data-console-sign-in-way
              onClick={() => {
                withCode.reset();
                setCode("");
                setWay(way === "code" ? "backup-code" : "code");
              }}
            >
              {way === "code" ? "Use a backup code" : "Use an authenticator's code"}
            </Button>
            <Button
              type="button"
              variant="link"
              onClick={() => {
                withCode.reset();
                setPassword("");
                setWay("password");
              }}
            >
              Start over
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="link"
            data-console-sign-in-way
            onClick={() => setWay(way === "password" ? "token" : "password")}
          >
            {way === "password" ? "Use an API token" : "Use a password"}
          </Button>
        )}
      </form>
    </main>
  );
}
