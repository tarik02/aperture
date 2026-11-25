import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import type { IpNetwork } from "effect/net/IpNetwork";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** A provider people sign in through: an OpenID Connect issuer this program is a client of. */
export interface Provider {
  /** What it is known by in addresses, such as that of its callback. */
  readonly id: string;
  /** What the page that signs people in calls it. */
  readonly name: string;
  /** Where it says how it is reached: its `/.well-known/openid-configuration`. */
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
}

/** What the control plane is told when it starts. */
export interface SettingsShape {
  /** The PostgreSQL database, as `postgres://user:password@host:port/database`. */
  readonly databaseUrl: Redacted.Redacted;
  readonly listenHost: string;
  readonly listenPort: number;
  /**
   * Where Prometheus metrics are served, at `/metrics`, as `127.0.0.1:9465`: an address of
   * their own beside the API's, which answers anyone who reaches it. None are served
   * without it.
   */
  readonly metricsListen: Option.Option<{ readonly host: string; readonly port: number }>;
  /**
   * Where a proxy before the nodes reaches this program, such as `http://10.0.0.2:7800`.
   * The address it listens on by default.
   */
  readonly internalUrl: string;
  /**
   * Where people reach this program from outside, such as `https://aperture.example`:
   * what signs them in takes requests from pages of that origin alone. Without it, the
   * origin is whatever a request says it came to.
   */
  readonly publicUrl: Option.Option<string>;
  /**
   * A directory with the console as it is built, which this program then serves beside
   * its API; none where something else serves the console, or nobody uses one.
   */
  readonly consoleDir: Option.Option<string>;
  /**
   * The proxies whose word is taken for where a request came from: addresses, and ranges
   * as `10.0.0.0/8` or `fd00::/8`. A request that comes from none of them came from where
   * its connection did, whatever it says.
   */
  readonly trustedProxies: ReadonlyArray<IpNetwork>;
  /** Whether signing in is held to so many tries a while from one address. */
  readonly rateLimit: boolean;
  /**
   * The providers people sign in through beside their passwords that are named here; an
   * admin adds others while the program runs, and changes none of these. A provider is
   * told to send people back to `/api/auth/callback/<id>`.
   */
  readonly providers: ReadonlyArray<Provider>;
  /**
   * Whether someone one of the providers named here vouches for, whom no admin made a
   * person, is made one when they first sign in. Without, they sign in only the people
   * there are. A provider an admin added says this of itself.
   */
  readonly provisionPeople: boolean;
  /**
   * The domains of the email addresses people are made for so, as `example.com`; any
   * address where none is named. A provider an admin added names its own.
   */
  readonly provisionDomains: ReadonlyArray<string>;
  /**
   * Whether an admin adds a provider that is reached without TLS on this machine itself,
   * as one that is tried out is. Any other is reached with TLS, whatever this says.
   */
  readonly providersOnLoopback: boolean;
  /** Lets its holder do what an admin does before there is any account. */
  readonly bootstrapToken: Redacted.Redacted;
  /**
   * Lets a proxy before the nodes read its routes and nothing else, so that the proxy is
   * given no token that does more.
   */
  readonly proxyToken: Option.Option<Redacted.Redacted>;
  /**
   * A registration token that is good without being made: for nodes that are set up
   * together with the control plane, before anyone could make one.
   */
  readonly registrationToken: Option.Option<Redacted.Redacted>;
  /**
   * A file with the master key: at least 32 bytes nobody guesses, such as what
   * `openssl rand -base64 32` gives. Secrets the control plane has to read again are
   * sealed with it, so it stays the same for as long as they are to be read.
   */
  readonly masterKeyFile: string;
  /** The Ed25519 private key tickets are signed with: PKCS#8, as PEM. */
  readonly ticketKeyFile: string;
  /** How long a ticket is good for. */
  readonly ticketLifetime: Duration.Duration;
  /** How long a node may send no keepalive before it is not used. */
  readonly nodeSilentAfter: Duration.Duration;
  /** How long an event is kept before it is forgotten. */
  readonly eventsKeep: Duration.Duration;
  /**
   * The commit this program was built from: the full sha, with `-dirty` after it for a tree
   * that had changes besides; none where whatever built it did not say. Between releases
   * every build has the last release's version, and this alone tells them apart. A package
   * sets it in what starts the program, as it does for the programs of a node.
   */
  readonly commit: Option.Option<string>;
}

export class Settings extends Context.Service<Settings, SettingsShape>()(
  "@aperture-browser/control/Settings",
) {}

/** How often a node is asked to send its keepalive: a few are lost before it counts as silent. */
export const keepaliveEvery = (settings: SettingsShape) =>
  Duration.divideUnsafe(settings.nodeSilentAfter, 3);
