// Fills an empty development instance with fake data, so list pages have enough rows to
// exercise scrolling, search, filters and pagination. `nix run .#dev -- --seed` runs it.
import {
  apiClientLayer,
  baseUrlLayer,
  SessionsApi,
  TenantsApi,
  TokensApi,
  UsersApi,
  type ApiCredentials,
  type CreateAdminTokenInput,
} from "@aperture-browser/api-client";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const adjectives = [
  "amber",
  "brisk",
  "cobalt",
  "dusty",
  "eager",
  "gentle",
  "hollow",
  "ivory",
  "lunar",
  "misty",
  "noble",
  "quiet",
  "rusty",
  "silent",
  "urban",
  "vivid",
] as const;
const nouns = [
  "anchor",
  "beacon",
  "canyon",
  "cedar",
  "compass",
  "falcon",
  "garden",
  "glacier",
  "harbor",
  "lantern",
  "meadow",
  "orchard",
  "prairie",
  "river",
  "summit",
  "willow",
] as const;
const firstNames = [
  "Ada",
  "Ben",
  "Cleo",
  "Dmytro",
  "Elif",
  "Farid",
  "Greta",
  "Hugo",
  "Iris",
  "Kira",
  "Mila",
  "Oskar",
  "Priya",
  "Sofia",
  "Viktor",
  "Yara",
] as const;
const lastNames = [
  "Becker",
  "Costa",
  "Dubois",
  "Haddad",
  "Ivanova",
  "Kowalski",
  "Larsen",
  "Moreau",
  "Nguyen",
  "Okafor",
  "Petrenko",
  "Rossi",
  "Silva",
  "Tanaka",
] as const;
const environments = ["staging", "production", "qa", "demo"] as const;
const suites = ["checkout", "login", "search", "billing", "onboarding"] as const;

const TENANT_COUNT = 140;
const USER_COUNT = 110;
const TOKEN_COUNT = 110;
// Sessions keep this many browsers running; the rest are suspended once they start.
const RUNNING_SESSION_COUNT = 3;
// Calls that only write rows; session creation stays sequential because each starts a browser.
const ROW_CONCURRENCY = 8;

class SeedRefused extends Data.TaggedError("SeedRefused")<{ readonly message: string }> {}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const seedInstance = Effect.fn("seedInstance")(function* (
  admin: ApiCredentials,
  sessionCount: number,
) {
  const tenantsApi = yield* TenantsApi;
  const usersApi = yield* UsersApi;
  const tokensApi = yield* TokensApi;
  const sessionsApi = yield* SessionsApi;

  // Only a freshly provisioned instance is seeded: its single default tenant and no users.
  const existingTenants = yield* tenantsApi.listTenants(admin, { limit: 2, deleted: "all" });
  const existingUsers = yield* usersApi.listUsers(admin, { limit: 1, disabled: "all" });
  const defaultTenant = existingTenants.data[0];
  if (!defaultTenant || existingTenants.data.length > 1 || existingUsers.data.length > 0) {
    return yield* new SeedRefused({
      message: "The instance already has data; seeding only fills a freshly provisioned one.",
    });
  }
  const tenantAdmin: ApiCredentials = { ...admin, selectedTenantId: defaultTenant.id };
  const existingSessions = yield* sessionsApi.listSessions(tenantAdmin, {
    limit: 1,
    includeDeleted: true,
  });
  if (existingSessions.data.length > 0) {
    return yield* new SeedRefused({
      message: `Tenant ${defaultTenant.displayName} already has sessions; seeding only fills a freshly provisioned instance.`,
    });
  }

  yield* Console.log(`Seeding ${TENANT_COUNT} tenants`);
  yield* Effect.forEach(
    Array.from({ length: TENANT_COUNT }, (_, index) => index + 1),
    Effect.fnUntraced(function* (index) {
      const name = `${capitalize(yield* Random.choice(adjectives))} ${yield* Random.choice(nouns)} ${index}`;
      const tenant = yield* tenantsApi.createTenant(admin, { displayName: name });
      if (index % 12 === 0) {
        yield* tenantsApi.deleteTenant(admin, tenant.id);
      }
    }),
    { concurrency: ROW_CONCURRENCY, discard: true },
  );

  yield* Console.log(`Seeding ${USER_COUNT} users`);
  yield* Effect.forEach(
    Array.from({ length: USER_COUNT }, (_, index) => index + 1),
    Effect.fnUntraced(function* (index) {
      const first = yield* Random.choice(firstNames);
      const last = yield* Random.choice(lastNames);
      const user = yield* usersApi.createUser(admin, {
        email: `${first.toLowerCase()}.${last.toLowerCase()}${index}@example.test`,
        displayName: `${first} ${last}`,
        isSystemAdmin: index % 15 === 0,
      });
      if (index % 20 === 0) {
        yield* usersApi.disableUser(admin, user.id);
      }
    }),
    { concurrency: ROW_CONCURRENCY, discard: true },
  );

  yield* Console.log(`Seeding ${TOKEN_COUNT} tokens`);
  yield* Effect.forEach(
    Array.from({ length: TOKEN_COUNT }, (_, index) => index + 1),
    Effect.fnUntraced(function* (index) {
      const name = `${yield* Random.choice(nouns)} automation ${index}`;
      const created = yield* tokensApi.createAdminToken(
        admin,
        index % 4 === 0
          ? {
              name,
              authorityType: "system_admin",
              scopes: ["system:admin"],
              resourceMode: "all",
              resourceGrants: [],
            }
          : {
              name,
              authorityType: "tenant",
              tenantId: defaultTenant.id,
              scopes: ["sessions:read", "sessions:write", "snapshots:read"],
              resourceMode: "all",
              resourceGrants: [],
            },
      );
      if (index % 7 === 0) {
        yield* tokensApi.revokeAdminToken(admin, created.token.id);
      }
    }),
    { concurrency: ROW_CONCURRENCY, discard: true },
  );
  // A revoked token releases its name, so a live token can take it again.
  const ciToken = {
    name: "ci deploy",
    authorityType: "system_admin",
    scopes: ["system:admin"],
    resourceMode: "all",
    resourceGrants: [],
  } satisfies CreateAdminTokenInput;
  const revoked = yield* tokensApi.createAdminToken(admin, ciToken);
  yield* tokensApi.revokeAdminToken(admin, revoked.token.id);
  yield* tokensApi.createAdminToken(admin, ciToken);

  const channels = yield* sessionsApi.getBrowserChannels(tenantAdmin);
  const channel = channels.channels[0]?.name;
  if (sessionCount > 0 && channel === undefined) {
    return yield* new SeedRefused({ message: "No browser channel is available for sessions." });
  }

  yield* Console.log(`Seeding ${sessionCount} sessions in tenant ${defaultTenant.displayName}`);
  for (let index = 1; index <= sessionCount && channel !== undefined; index++) {
    const suite = yield* Random.choice(suites);
    const created = yield* sessionsApi.createSession(
      tenantAdmin,
      {
        label: `${suite} ${yield* Random.choice(adjectives)} run ${index}`,
        browser: { channel },
        tags: { environment: yield* Random.choice(environments), suite },
      },
      { waitForReady: true },
    );
    const sessionId = created.session.id;
    yield* Console.log(`  session ${index}/${sessionCount}`);
    if (index <= RUNNING_SESSION_COUNT) {
      continue;
    }
    yield* sessionsApi.suspendSession(tenantAdmin, sessionId);
    if (index % 8 === 0) {
      yield* sessionsApi.deleteSession(tenantAdmin, sessionId);
    } else {
      yield* sessionsApi.promoteSession(tenantAdmin, sessionId, {
        name: `${yield* Random.choice(adjectives)}-${yield* Random.choice(nouns)}-${index}`,
        description: "Seeded snapshot",
      });
    }
  }

  yield* Console.log("Seeded");
});

const seed = Command.make(
  "seed-dev",
  {
    url: Flag.String("url").pipe(Flag.withDescription("Aperture base URL")),
    tokenFile: Flag.File("token-file").pipe(
      Flag.withDescription("File holding a system-admin API token"),
    ),
    sessions: Flag.Int("sessions").pipe(
      Flag.withDescription("Browser sessions to create; each one starts a browser"),
      Flag.withDefault(15),
    ),
  },
  Effect.fn(function* ({ url, tokenFile, sessions }) {
    const fs = yield* FileSystem.FileSystem;
    const token = (yield* fs.readFileString(tokenFile)).trim();
    const admin: ApiCredentials = {
      kind: "bearer",
      token: Redacted.make(token),
      authorityType: "system_admin",
      tenantId: null,
      selectedTenantId: null,
    };
    yield* seedInstance(admin, sessions).pipe(
      Effect.catchTag("SeedRefused", (error) => Console.log(error.message)),
      Effect.provide(
        apiClientLayer.pipe(Layer.provide(baseUrlLayer(url)), Layer.provide(FetchHttpClient.layer)),
      ),
    );
  }),
);

NodeRuntime.runMain(
  Command.run(seed, { version: "0.0.0" }).pipe(
    Effect.tapError((error) =>
      CliError.isCliError(error) ? Effect.void : Console.error(String(error)),
    ),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
