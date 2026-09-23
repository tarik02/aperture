import {
  createApiClient,
  type ApiCredentials,
  type InitialBrowserStorageState,
  type InitialBrowserTarget,
} from "@aperture/api-client";
import { z } from "zod";

const connectionSchema = z.object({
  id: z.string().min(1),
  origin: z.url(),
  token: z.string().min(1),
  authorityType: z.enum(["system_admin", "tenant"]),
  tenantId: z.string().nullable(),
  selectedTenantId: z.string().nullable(),
  tenantName: z.string(),
  channel: z.string().min(1),
  channels: z.array(z.string().min(1)).min(1),
  scopes: z.array(z.string()),
});

const connectionDraftSchema = z.object({
  origin: z.string(),
  token: z.string(),
});

const connectionStoreSchema = z.object({
  connections: z.array(connectionSchema),
  activeConnectionId: z.string().nullable(),
});

export type Connection = z.infer<typeof connectionSchema>;
export type ConnectionDraft = z.infer<typeof connectionDraftSchema>;
export type StorageState = InitialBrowserStorageState;
export type InitialTarget = InitialBrowserTarget;
export interface CreateSessionOptions {
  targets: InitialTarget[];
  storageState?: StorageState;
  baseSnapshotName?: string;
  label?: string;
  tags?: Record<string, string>;
  waitForReady?: boolean;
}

const connectionStoreKey = "apertureConnections";
const connectionDraftKey = "apertureConnectionDraft";

export async function connect(originInput: string, token: string): Promise<Connection> {
  const parsedOrigin = new URL(originInput.trim());
  if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
    throw new Error("Aperture URL must use HTTP or HTTPS");
  }
  const origin = parsedOrigin.origin;
  const normalizedToken = token.trim();
  if (normalizedToken === "") {
    throw new Error("API token is required");
  }
  const permission = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!permission) {
    throw new Error("Access to the Aperture instance was not granted");
  }

  const client = createApiClient({ baseUrl: origin });
  const provisionalCredentials: ApiCredentials = {
    kind: "bearer",
    token: normalizedToken,
    authorityType: null,
    tenantId: null,
    selectedTenantId: null,
  };
  const auth = await client.getAuthMe(null, provisionalCredentials);
  if (auth.selectedTenant === null) {
    throw new Error("The Aperture token has no active tenant");
  }
  const authenticatedCredentials: ApiCredentials = {
    kind: "bearer",
    token: normalizedToken,
    authorityType: auth.principal.authorityType,
    tenantId: auth.principal.tenantId,
    selectedTenantId:
      auth.principal.authorityType === "system_admin" ? auth.selectedTenant.id : null,
  };
  const channelsResponse = await client.getBrowserChannels(authenticatedCredentials);
  const channels = channelsResponse.channels.map(({ name }) => name);
  const connected = connectionSchema.parse({
    id: crypto.randomUUID(),
    origin,
    token: normalizedToken,
    authorityType: authenticatedCredentials.authorityType,
    tenantId: authenticatedCredentials.tenantId,
    selectedTenantId: authenticatedCredentials.selectedTenantId,
    tenantName: auth.selectedTenant.displayName,
    channel: channels[0],
    channels,
    scopes: auth.principal.scopes,
  });
  const store = await getConnectionStore();
  await saveConnectionStore({
    connections: [...store.connections, connected],
    activeConnectionId: connected.id,
  });
  await chrome.storage.session.remove(connectionDraftKey);
  return connected;
}

export async function getConnection(): Promise<Connection | null> {
  const store = await getConnectionStore();
  return store.connections.find(({ id }) => id === store.activeConnectionId) ?? null;
}

export async function listConnections(): Promise<Connection[]> {
  return (await getConnectionStore()).connections;
}

export async function selectConnection(id: string): Promise<void> {
  const store = await getConnectionStore();
  if (!store.connections.some((connection) => connection.id === id)) {
    throw new Error("The Aperture connection is unavailable");
  }
  await saveConnectionStore({ ...store, activeConnectionId: id });
}

export async function saveConnection(connection: Connection): Promise<void> {
  const parsed = connectionSchema.parse(connection);
  const store = await getConnectionStore();
  if (!store.connections.some(({ id }) => id === parsed.id)) {
    throw new Error("The Aperture connection is unavailable");
  }
  await saveConnectionStore({
    ...store,
    connections: store.connections.map((current) => (current.id === parsed.id ? parsed : current)),
  });
}

export async function getConnectionDraft(): Promise<ConnectionDraft> {
  const stored = await chrome.storage.session.get(connectionDraftKey);
  const parsed = connectionDraftSchema.safeParse(stored[connectionDraftKey]);
  return parsed.success ? parsed.data : { origin: "", token: "" };
}

export async function saveConnectionDraft(draft: ConnectionDraft): Promise<void> {
  await chrome.storage.session.set({ [connectionDraftKey]: connectionDraftSchema.parse(draft) });
}

export async function removeConnection(id: string): Promise<void> {
  const store = await getConnectionStore();
  const connections = store.connections.filter((connection) => connection.id !== id);
  const activeConnectionId =
    store.activeConnectionId === id ? (connections[0]?.id ?? null) : store.activeConnectionId;
  await saveConnectionStore({ connections, activeConnectionId });
}

export async function reorderConnection(
  sourceId: string,
  destinationId: string,
  placement: "before" | "after",
): Promise<Connection[]> {
  const store = await getConnectionStore();
  const sourceIndex = store.connections.findIndex((connection) => connection.id === sourceId);
  const destinationIndex = store.connections.findIndex(
    (connection) => connection.id === destinationId,
  );
  if (sourceIndex === -1 || destinationIndex === -1 || sourceIndex === destinationIndex) {
    return store.connections;
  }

  const connections = [...store.connections];
  const moved = connections.splice(sourceIndex, 1)[0];
  if (moved === undefined) {
    return store.connections;
  }
  const adjustedDestinationIndex = connections.findIndex(
    (connection) => connection.id === destinationId,
  );
  const insertionIndex = adjustedDestinationIndex + (placement === "after" ? 1 : 0);
  connections.splice(insertionIndex, 0, moved);

  if (connections.every((connection, index) => connection.id === store.connections[index]?.id)) {
    return store.connections;
  }
  await saveConnectionStore({ ...store, connections });
  return connections;
}

export async function listSnapshots(connection: Connection): Promise<string[]> {
  const client = createApiClient({ baseUrl: connection.origin });
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listSnapshots(credentials(connection), { limit: 100, cursor });
    names.push(...page.data.map(({ name }) => name));
    cursor = page.meta.hasMore ? page.meta.nextCursor : undefined;
  } while (cursor !== undefined);
  return names;
}

export async function createSession(
  connection: Connection,
  options: CreateSessionOptions,
): Promise<string> {
  const client = createApiClient({ baseUrl: connection.origin });
  const result = await client.createSession(
    credentials(connection),
    {
      browser: { channel: connection.channel, args: [] },
      initialTargets: options.targets,
      ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
      ...(options.baseSnapshotName === undefined || options.baseSnapshotName === ""
        ? {}
        : { baseSnapshotName: options.baseSnapshotName }),
      ...(options.label === undefined || options.label.trim() === ""
        ? {}
        : { label: options.label.trim() }),
      tags: options.tags,
    },
    { waitForReady: options.waitForReady },
  );
  return result.session.id;
}

export async function promoteSession(
  connection: Connection,
  sessionId: string,
  name: string,
  description: string,
  tags: Record<string, string>,
): Promise<void> {
  const client = createApiClient({ baseUrl: connection.origin });
  await client.deleteSession(credentials(connection), sessionId);
  await client.promoteSession(credentials(connection), sessionId, {
    name: name.trim(),
    description: description.trim() || null,
    force: true,
    tags,
  });
}

export async function openWorkbench(connection: Connection, sessionId: string): Promise<void> {
  await chrome.tabs.create({
    url: `${connection.origin}/-/sessions/${encodeURIComponent(sessionId)}`,
  });
}

export async function openSnapshots(connection: Connection): Promise<void> {
  await chrome.tabs.create({ url: `${connection.origin}/-/snapshots/` });
}

export function hasScope(connection: Connection, scope: string): boolean {
  return connection.scopes.includes("system:admin") || connection.scopes.includes(scope);
}

function credentials(connection: Connection): ApiCredentials {
  return {
    kind: "bearer",
    token: connection.token,
    authorityType: connection.authorityType,
    tenantId: connection.tenantId,
    selectedTenantId: connection.selectedTenantId,
  };
}

async function getConnectionStore(): Promise<z.infer<typeof connectionStoreSchema>> {
  const stored = await chrome.storage.local.get(connectionStoreKey);
  const parsed = connectionStoreSchema.safeParse(stored[connectionStoreKey]);
  return parsed.success ? parsed.data : { connections: [], activeConnectionId: null };
}

async function saveConnectionStore(store: z.infer<typeof connectionStoreSchema>): Promise<void> {
  await chrome.storage.local.set({ [connectionStoreKey]: connectionStoreSchema.parse(store) });
}
