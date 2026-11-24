import * as Site from "@aperture-browser/e2e/src/site.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { signInBy } from "./sso.ts";

/** An address someone has at the provider, as its list of them tells it. */
interface Address {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

/** Someone who has an account at the provider. */
interface Member {
  readonly login: string;
  readonly id: number;
  readonly name: string | null;
  readonly emails: ReadonlyArray<Address>;
}

/**
 * Who has an account there. Ada's first address is verified. Eve's first is not, and the
 * one she has that is verified is Bob's here: neither of them is hers to sign in with.
 * Nobody says of Mallory's address whose it is at all.
 */
export const MEMBERS = [
  {
    login: "ada",
    id: 1001,
    name: "Ada of the hub",
    emails: [
      { email: "ada-elsewhere@example.test", primary: false, verified: true },
      { email: "ada@example.test", primary: true, verified: true },
    ],
  },
  {
    login: "eve",
    id: 1002,
    name: null,
    emails: [
      { email: "eve@example.test", primary: true, verified: false },
      { email: "bob@example.test", primary: false, verified: true },
    ],
  },
  { login: "mallory", id: 1003, name: "Mallory", emails: [] },
  // Nobody made these people where they come to: the provider's word alone does, or not.
  {
    login: "grace",
    id: 1004,
    name: "Grace",
    emails: [{ email: "grace@example.test", primary: true, verified: true }],
  },
  {
    login: "heidi",
    id: 1005,
    name: "Heidi",
    emails: [{ email: "heidi@elsewhere.test", primary: true, verified: true }],
  },
  {
    login: "ivan",
    id: 1006,
    name: "Ivan",
    emails: [{ email: "ivan@example.test", primary: true, verified: false }],
  },
] as const satisfies ReadonlyArray<Member>;
export type Login = (typeof MEMBERS)[number]["login"];

export interface HubService {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where it is asked, as an admin says them of such a provider. */
  readonly endpoints: {
    readonly authorization: string;
    readonly token: string;
    readonly userInfo: string;
    readonly emails: string;
  };
}

/**
 * A provider that speaks OAuth 2.0 and no OpenID Connect, as GitHub does: it signs no
 * token that says who someone is, and tells it where it is asked with their access token.
 */
export class Hub extends Context.Service<Hub, HubService>()(
  "@aperture-browser/control/tests/Hub",
) {}

const CLIENT_ID = "aperture-at-the-hub";
const CLIENT_SECRET = "the-secret-of-the-hub-client";
const CODE = "code-of-";
const TOKEN = "token-of-";

const refused = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

export const start = Effect.gen(function* () {
  const site = yield* Site.serve(
    Site.by(
      Effect.fn(function* (request) {
        const asked = new URL(request.url, "http://hub.invalid");
        const bearer = /^Bearer (.+)$/u.exec(request.headers["authorization"] ?? "")?.[1] ?? "";
        const member = MEMBERS.find((one) => bearer === `${TOKEN}${one.login}`);
        switch (asked.pathname) {
          case "/login/oauth/authorize": {
            // Whoever is to sign in is said with the address, in place of a form.
            const login = asked.searchParams.get("login");
            const back = asked.searchParams.get("redirect_uri");
            if (login === null || back === null) {
              return HttpServerResponse.text("Sign in to the hub", { status: 200 });
            }
            const to = new URL(back);
            to.searchParams.set("code", `${CODE}${login}`);
            to.searchParams.set("state", asked.searchParams.get("state") ?? "");
            return HttpServerResponse.redirect(to, { status: 302 });
          }
          case "/login/oauth/access_token": {
            const sent = new URLSearchParams(yield* request.text);
            const basic = /^Basic (.+)$/u.exec(request.headers["authorization"] ?? "")?.[1];
            const [id, secret] =
              basic === undefined
                ? [sent.get("client_id"), sent.get("client_secret")]
                : atob(basic).split(":");
            // As GitHub has it: a client it does not know is told there is nothing here.
            if (id !== CLIENT_ID) {
              return refused(404, "Not Found");
            }
            const code = sent.get("code") ?? "";
            if (secret !== CLIENT_SECRET || !code.startsWith(CODE)) {
              return refused(200, "bad_verification_code");
            }
            return HttpServerResponse.jsonUnsafe({
              access_token: `${TOKEN}${code.slice(CODE.length)}`,
              token_type: "bearer",
              scope: "read:user,user:email",
            });
          }
          case "/user":
            return member === undefined
              ? refused(401, "Requires authentication")
              : HttpServerResponse.jsonUnsafe({
                  id: member.id,
                  login: member.login,
                  name: member.name,
                  // Not told here, as where someone keeps their address to themselves.
                  email: null,
                });
          case "/user/emails":
            return member === undefined
              ? refused(401, "Requires authentication")
              : HttpServerResponse.jsonUnsafe(member.emails);
          default:
            return refused(404, "Not Found");
        }
      }),
    ),
  );
  return {
    url: site.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    endpoints: {
      authorization: `${site.url}/login/oauth/authorize`,
      token: `${site.url}/login/oauth/access_token`,
      userInfo: `${site.url}/user`,
      emails: `${site.url}/user/emails`,
    },
  } satisfies HubService;
});

export const layer = Layer.effect(Hub, start);

/** Signs in through a provider an admin made of the hub, as one of those who are there. */
export const signInThroughHub = Effect.fn("Control.signInThroughHub")(function* (
  base: string,
  provider: string,
  login: Login,
  to = "/-/sessions",
) {
  return yield* signInBy(
    base,
    provider,
    to,
    (sent) => {
      const at = new URL(sent);
      at.searchParams.set("login", login);
      return at;
    },
    {},
  );
});
