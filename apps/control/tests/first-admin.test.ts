import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Control from "./src/control.ts";
import { cookiesOf } from "./src/person.ts";

const LOGGED = /^Setup link: (\S+)$/u;

/** The links a control plane logged to make the first admin at. */
const links = (control: Control.ControlService) =>
  control
    .warned()
    .map((line) => LOGGED.exec(line)?.[1])
    .filter((link) => link !== undefined);

/** The token a link carries, which is after its `#`. */
const tokenOf = (link: string) =>
  new URLSearchParams(new URL(link).hash.slice(1)).get("token") ?? "";

suite(Control.layer())("the first admin of a deployment", (it) => {
  it.effect(
    "a control plane nobody signs in at logs one link, under the address people reach",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const [link, ...others] = links(control);
        expect(others).toEqual([]);
        expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup#token=[\w-]{40,}$/u);

        // A service account is no person: the link stays good beside it.
        yield* Control.account("a robot", true);
        const anyone = yield* control.as("");
        expect(yield* anyone.firstAdmin.awaited()).toEqual({ awaited: true });

        // Another program of the deployment tells the same link, where people reach it.
        const second = yield* Control.start({
          beside: control,
          publicUrl: "https://aperture.example/",
        });
        expect(links(second)).toEqual([
          `https://aperture.example/setup#token=${tokenOf(link ?? "")}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("whoever has the link is made an admin and signs in, and of two who come one is", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const second = yield* Control.start({ beside: control });
      const token = tokenOf(links(control)[0] ?? "");
      const password = "a password of the first admin's own";
      const here = yield* control.as("");
      const there = yield* second.as("");

      const guessed = yield* Effect.flip(
        here.firstAdmin.create({
          payload: { token: `${token}x`, name: "Eve", email: "eve@example.test", password },
        }),
      );
      expect(guessed._tag).toBe("Forbidden");
      // What makes nobody a person leaves the link as it was.
      const short = yield* Effect.flip(
        here.firstAdmin.create({
          payload: { token, name: "Ada", email: "ada@example.test", password: "short" },
        }),
      );
      expect(short._tag).toBe("AccountInvalid");
      expect(yield* here.firstAdmin.awaited()).toEqual({ awaited: true });

      // Two at once, each at a program of its own: one of them is the first.
      const came = yield* Effect.all(
        [
          Effect.result(
            here.firstAdmin.create({
              payload: { token, name: "Ada", email: "ada@example.test", password },
            }),
          ),
          Effect.result(
            there.firstAdmin.create({
              payload: { token, name: "Bob", email: "bob@example.test", password },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const made = came.flatMap((one) => (one._tag === "Success" ? [one.success] : []));
      const refused = came.flatMap((one) => (one._tag === "Failure" ? [one.failure] : []));
      expect(made).toHaveLength(1);
      expect(refused.map((error) => error._tag)).toEqual(["Forbidden"]);
      const [first] = made;
      expect(first).toMatchObject({ kind: "person", admin: true });

      const bootstrap = yield* control.as(control.bootstrapToken);
      const people = (yield* bootstrap.accounts.list()).filter((one) => one.kind === "person");
      expect(people.map((one) => one.id)).toEqual([first?.id]);
      expect(people[0]?.signIn).toMatchObject({ password: true });

      const signedIn = yield* http.execute(
        HttpClientRequest.post(`${control.url}/api/auth/sign-in/email`).pipe(
          HttpClientRequest.setHeader("origin", control.url),
          HttpClientRequest.bodyJsonUnsafe({ email: first?.email, password }),
        ),
      );
      expect(signedIn.status).toBe(200);
      const current = yield* http.execute(
        HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
          HttpClientRequest.setHeader("cookie", cookiesOf(signedIn)),
        ),
      );
      expect(yield* current.json).toMatchObject({ id: first?.id, admin: true });

      // Written down as done by someone who was nobody yet, and never with the token.
      const { events } = yield* bootstrap.events.list({
        query: { kind: "account.created", resourceId: first?.id ?? "" },
      });
      expect(events.map((event) => [event.actor.kind, event.detail["first"]])).toEqual([
        ["anonymous", true],
      ]);
      expect(JSON.stringify(yield* bootstrap.events.list({ query: { limit: 200 } }))).not.toContain(
        token,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("the link is good once: nobody is made with it again, and no later start logs it", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const token = tokenOf(links(control)[0] ?? "");
      const anyone = yield* control.as("");
      expect(yield* anyone.firstAdmin.awaited()).toEqual({ awaited: false });
      const again = yield* Effect.flip(
        anyone.firstAdmin.create({
          payload: {
            token,
            name: "Cy",
            email: "cy@example.test",
            password: "a password of Cy's own",
          },
        }),
      );
      expect(again._tag).toBe("Forbidden");

      const later = yield* Control.start({ beside: control });
      expect(links(later)).toEqual([]);
      expect(yield* (yield* later.as("")).firstAdmin.awaited()).toEqual({ awaited: false });

      // The bootstrap token does what it did.
      const made = yield* Control.account("another robot");
      expect((yield* made.api.accounts.current()).id).toBe(made.account.id);
    }).pipe(Effect.scoped),
  );
});

suite(Control.layer())("the first admin where the bootstrap token made a person", (it) => {
  it.effect("the link that was logged makes nobody once anyone is a person", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const token = tokenOf(links(control)[0] ?? "");
      expect(token).not.toBe("");
      const bootstrap = yield* control.as(control.bootstrapToken);
      const dee = yield* bootstrap.accounts.create({
        payload: { name: "Dee", email: "dee@example.test" },
      });

      const anyone = yield* control.as("");
      expect(yield* anyone.firstAdmin.awaited()).toEqual({ awaited: false });
      const refused = yield* Effect.flip(
        anyone.firstAdmin.create({
          payload: {
            token,
            name: "Eli",
            email: "eli@example.test",
            password: "a password of Eli's own",
          },
        }),
      );
      expect(refused._tag).toBe("Forbidden");
      const people = (yield* bootstrap.accounts.list()).filter((one) => one.kind === "person");
      expect(people.map((one) => one.id)).toEqual([dee.id]);

      const later = yield* Control.start({ beside: control });
      expect(links(later)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
