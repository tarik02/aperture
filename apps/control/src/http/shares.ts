import { PREFIX, ShareRole } from "@aperture-browser/control-api";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShareRefused } from "../errors.ts";
import { Settings } from "../settings/service.ts";
import { guestName } from "../shares/layer.ts";
import { Shares } from "../shares/service.ts";
import { after } from "../time.ts";
import { clientAddress } from "./client-address.ts";
import { carried, guestOf, LINK_COOKIE, SHARE_COOKIE } from "./guest.ts";
import { overTls } from "./origin.ts";

/** Where a guest's page asks about the link it was opened with. */
export const sharePath = (id: string) => `${PREFIX}/share/${encodeURIComponent(id)}`;

const ASKED_AT = new RegExp(`^${PREFIX}/share/([^/?#]+)(?:[?#]|$)`, "u");
/** How long a browser carries a link that is good for longer, or for ever. */
const CARRIED_MOST = Duration.days(30);

const STATUS = { ShareRefused: 401, TooManyTries: 429 } as const;

const refused = (error: { readonly _tag: keyof typeof STATUS }) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(error, {
      status: STATUS[error._tag],
      headers: { "cache-control": "no-store" },
    }),
  );

/** What a guest's page sends: the link's secret when it first has it, a name when one is chosen. */
const Asked = Schema.Struct({
  token: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

/** What the page is told of the link, and nothing of who made it. */
const Told = Schema.Struct({
  sessionId: Schema.String,
  /** Where the session is reached; none for one that is on no node. */
  path: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  role: ShareRole,
  /** The number of the one tab the link shows; the whole session, without. */
  tab: Schema.NullOr(Schema.Int),
  /**
   * What the guest is called there: what they said, else whom the link is for, else a
   * guest's name of its own.
   */
  name: Schema.String,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
const told = Schema.encodeSync(Told);

/** What a guest with a share link asks of the control plane, which is this and nothing else. */
export const layer = HttpRouter.use(
  Effect.fn(function* (router) {
    const shares = yield* Shares;
    const settings = yield* Settings;

    /**
     * Takes a guest's link in exchange for cookies the browser carries: one to this
     * address, so that the page is shown again, and one to the session's path, by which
     * the proxy lets them in, with what the guest is called. Asked again, it tells where
     * the session is now, and whether the link is still good; asked with a name, the
     * guest is called that from then on.
     */
    const enter = Effect.fn("Shares.http.enter")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const [, written = ""] = ASKED_AT.exec(request.url) ?? [];
      const id = decodeURIComponent(written);
      const asked = yield* HttpServerRequest.schemaBodyJson(Asked).pipe(
        Effect.orElseSucceed((): typeof Asked.Type => ({})),
      );
      const kept = guestOf(request, LINK_COOKIE);
      const token = Option.fromUndefinedOr(asked.token).pipe(
        Option.orElse(() => Option.map(kept, (guest) => guest.token)),
      );
      if (Option.isNone(token)) {
        return yield* new ShareRefused({ message: "no link came with the request" });
      }
      const from = clientAddress(
        settings.trustedProxies,
        request.remoteAddress,
        request.headers["x-forwarded-for"],
      );
      const said =
        asked.name === undefined || asked.name.trim() === ""
          ? Option.none<string>()
          : Option.some(guestName(asked.name));
      // What the browser carries is of this link, or of none.
      const before = Option.filter(
        kept,
        (guest) => guest.token === token.value && guest.name !== "",
      ).pipe(Option.map((guest) => guest.name));
      const entered = yield* shares.enter(id, token.value, from, { said, kept: before });
      const { name } = entered;
      const guest = carried({ token: token.value, name });
      const longest = DateTime.fromDateUnsafe(yield* after(CARRIED_MOST));
      const cookie = {
        httpOnly: true,
        sameSite: "strict",
        secure: overTls(settings, request),
        expires: DateTime.toDate(
          entered.expiresAt === null ? longest : DateTime.min(entered.expiresAt, longest),
        ),
      } as const;
      const answer = HttpServerResponse.jsonUnsafe(
        told({
          sessionId: entered.share.sessionId,
          path: entered.path,
          running: entered.running,
          role: entered.share.role,
          tab: entered.share.tab,
          name,
          expiresAt: entered.expiresAt,
        }),
        { headers: { "cache-control": "no-store" } },
      ).pipe(HttpServerResponse.setCookie(LINK_COOKIE, guest, { ...cookie, path: sharePath(id) }));
      return yield* (
        entered.path === null
          ? answer
          : Effect.flatMap(
              answer,
              HttpServerResponse.setCookie(SHARE_COOKIE, guest, { ...cookie, path: entered.path }),
            )
      ).pipe(Effect.orDie);
    }, Effect.catch(refused));

    yield* router.add("POST", `${PREFIX}/share/:id`, enter);
  }),
);
