import "./popup.css";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@aperture/ui/components/accordion";
import { Alert, AlertDescription } from "@aperture/ui/components/alert";
import { Button } from "@aperture/ui/components/button";
import { Checkbox } from "@aperture/ui/components/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@aperture/ui/components/combobox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture/ui/components/field";
import { Input } from "@aperture/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@aperture/ui/components/popover";
import { ScrollArea } from "@aperture/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture/ui/components/select";
import { Separator } from "@aperture/ui/components/separator";
import { Spinner } from "@aperture/ui/components/spinner";
import { entriesToTags, TagEditor, type TagEntry } from "@aperture/ui/components/tag-editor";
import { Textarea } from "@aperture/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@aperture/ui/components/toggle-group";
import { cn } from "@aperture/ui/utils";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Globe2Icon,
  GripVerticalIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { requestCapturePermissions } from "./capture.ts";
import {
  connect,
  getConnection,
  getConnectionDraft,
  hasScope,
  listConnections,
  listSnapshots,
  reorderConnection,
  removeConnection,
  saveConnection,
  saveConnectionDraft,
  selectConnection,
  type Connection,
  type ConnectionDraft,
} from "./connection.ts";
import { teleportTabsResultSchema, type TeleportTabsCommand } from "./commands.ts";
import {
  getPopupState,
  savePopupState,
  type PopupScreen,
  type PopupState,
  type TeleportDestination,
} from "./popup-state.ts";
import {
  clearCompletedTeleportOperation,
  getTeleportOperation,
  isTeleportOperationRunning,
  subscribeToTeleportOperation,
  type TeleportOperation,
} from "./teleport-operation.ts";

const blankSnapshotValue = "__blank__";
const connectionDragKind = "aperture-connection";
const defaultTags: TagEntry[] = [
  { key: "source", value: "aperture-companion" },
  { key: "action", value: "teleport" },
];

type ConnectionDragData = {
  kind: typeof connectionDragKind;
  connectionId: string;
};

type DropPlacement = "before" | "after";

type BrowserWindowTabs = {
  id: number;
  label: string;
  tabs: chrome.tabs.Tab[];
};

type Status = {
  message: string;
  kind: "neutral" | "error";
};

type PendingAction = "connect" | "connection" | "remove" | "reorder" | "channel" | "teleport";

function CompanionPopup() {
  const [initialized, setInitialized] = useState(false);
  const [screen, setScreen] = useState<PopupScreen>("home");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null);
  const [browserWindows, setBrowserWindows] = useState<BrowserWindowTabs[]>([]);
  const [selectedTabIds, setSelectedTabIds] = useState<number[]>([]);
  const [draftTabIds, setDraftTabIds] = useState<number[]>([]);
  const [snapshots, setSnapshots] = useState<string[] | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState(blankSnapshotValue);
  const [destination, setDestination] = useState<TeleportDestination>("session");
  const [advanced, setAdvanced] = useState(false);
  const [resourceName, setResourceName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<TagEntry[]>(defaultTags);
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [teleportOperation, setTeleportOperation] = useState<TeleportOperation | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const teleporting = pendingAction === "teleport" || isTeleportOperationRunning(teleportOperation);
  const teleportButtonLabel = teleportProgressLabel(teleportOperation, pendingAction);
  const managingConnection =
    pendingAction === "connection" || pendingAction === "remove" || pendingAction === "reorder";
  const busy = pendingAction !== null || isTeleportOperationRunning(teleportOperation);

  useEffect(() => {
    const unsubscribe = subscribeToTeleportOperation((operation) => {
      setTeleportOperation(operation);
      const operationStatus = statusFromTeleportOperation(operation);
      if (operationStatus !== null) {
        setStatus(operationStatus);
      }
      if (operation !== null && !isTeleportOperationRunning(operation)) {
        void clearCompletedTeleportOperation(operation.id);
      }
    });
    void initialize()
      .catch((error: unknown) => {
        setStatus({ message: errorMessage(error), kind: "error" });
      })
      .finally(() => setInitialized(true));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!initialized) {
      return;
    }
    void savePopupState({
      connectionId: connection?.id ?? null,
      screen,
      selectedTabIds,
      draftTabIds,
      selectedSnapshot,
      destination,
      advanced,
      resourceName,
      description,
      tags,
    }).catch((error: unknown) => {
      setStatus({ message: errorMessage(error), kind: "error" });
    });
  }, [
    advanced,
    connection?.id,
    description,
    destination,
    draftTabIds,
    initialized,
    resourceName,
    screen,
    selectedSnapshot,
    selectedTabIds,
    tags,
  ]);

  async function initialize() {
    const [storedConnections, storedConnection, draft, active, restoredState, operation] =
      await Promise.all([
        listConnections(),
        getConnection(),
        getConnectionDraft(),
        activeTab(),
        getPopupState(),
        getTeleportOperation(),
      ]);
    setConnections(storedConnections);
    setOrigin(draft.origin);
    setToken(draft.token);
    setCurrentTab(active);
    setTeleportOperation(operation);
    const operationStatus = statusFromTeleportOperation(operation);
    if (operationStatus !== null) {
      setStatus(operationStatus);
    }
    if (operation !== null && !isTeleportOperationRunning(operation)) {
      void clearCompletedTeleportOperation(operation.id);
    }
    if (storedConnection === null) {
      setScreen("add-connection");
      return;
    }
    setConnection(storedConnection);
    await loadBrowserContext(storedConnection, active, restoredState);
  }

  async function loadBrowserContext(
    activeConnection: Connection,
    active: chrome.tabs.Tab | null,
    restoredState: PopupState | null = null,
  ) {
    const [windows, loadedSnapshots] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      hasScope(activeConnection, "snapshots:read")
        ? listSnapshots(activeConnection).catch(() => null)
        : Promise.resolve(null),
    ]);
    const groupedWindows = groupTabsByWindow(windows, active?.windowId);
    const canRestore = restoredState?.connectionId === activeConnection.id;
    const initialTabIds = active?.id === undefined || !isWebURL(active.url) ? [] : [active.id];
    const selectedTabs = canRestore
      ? reconcileTabIds(restoredState.selectedTabIds, groupedWindows, active)
      : initialTabIds;
    const draftTabs = canRestore
      ? reconcileTabIds(restoredState.draftTabIds, groupedWindows, active)
      : initialTabIds;
    const restoredSnapshot = canRestore ? restoredState.selectedSnapshot : blankSnapshotValue;

    setBrowserWindows(groupedWindows);
    setSelectedTabIds(selectedTabs);
    setDraftTabIds(draftTabs);
    setSnapshots(loadedSnapshots);
    setSelectedSnapshot(
      restoredSnapshot === blankSnapshotValue || loadedSnapshots?.includes(restoredSnapshot)
        ? restoredSnapshot
        : blankSnapshotValue,
    );
    setScreen(canRestore ? restoredState.screen : "home");
    setDestination(
      canRestore &&
        restoredState.destination === "snapshot" &&
        hasScope(activeConnection, "snapshots:write")
        ? "snapshot"
        : "session",
    );
    setAdvanced(canRestore ? restoredState.advanced : false);
    setResourceName(canRestore ? restoredState.resourceName : (active?.title?.trim() ?? ""));
    setDescription(canRestore ? restoredState.description : "");
    setTags(canRestore ? restoredState.tags : defaultTags);
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("connect", async () => {
      const connected = await connect(origin, token);
      setConnections(await listConnections());
      setConnection(connected);
      setToken("");
      setConnectionMenuOpen(false);
      setScreen("home");
      await loadBrowserContext(connected, currentTab);
      setStatus({ message: "Connected.", kind: "neutral" });
    });
  }

  function updateConnectionDraft(draft: ConnectionDraft) {
    setOrigin(draft.origin);
    setToken(draft.token);
    void saveConnectionDraft(draft).catch((error: unknown) => {
      setStatus({ message: errorMessage(error), kind: "error" });
    });
  }

  async function handleConnectionChange(id: string | null) {
    if (id === null) {
      return;
    }
    if (id === connection?.id) {
      setConnectionMenuOpen(false);
      return;
    }
    await run("connection", async () => {
      const selected = connections.find((candidate) => candidate.id === id);
      if (selected === undefined) {
        throw new Error("The Aperture connection is unavailable");
      }
      await selectConnection(id);
      setConnection(selected);
      setConnectionMenuOpen(false);
      await loadBrowserContext(selected, currentTab);
      setStatus(null);
    });
  }

  async function handleRemoveConnection(id: string) {
    await run("remove", async () => {
      await removeConnection(id);
      const [remaining, activeConnection] = await Promise.all([listConnections(), getConnection()]);
      setConnections(remaining);
      setConnection(activeConnection);
      if (activeConnection === null) {
        setSnapshots(null);
        setConnectionMenuOpen(false);
        setScreen("add-connection");
      } else if (activeConnection.id !== connection?.id) {
        await loadBrowserContext(activeConnection, currentTab);
      }
      setPendingRemoval(null);
      setStatus({ message: "Connection removed.", kind: "neutral" });
    });
  }

  async function handleReorderConnection(
    sourceId: string,
    destinationId: string,
    placement: DropPlacement,
  ) {
    await run("reorder", async () => {
      setConnections(await reorderConnection(sourceId, destinationId, placement));
      setStatus(null);
    });
  }

  async function handleChannelChange(channel: string | null) {
    if (channel === null || connection === null) {
      return;
    }
    await run("channel", async () => {
      const updated = { ...connection, channel };
      await saveConnection(updated);
      setConnection(updated);
      setConnections((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      setStatus({ message: "Browser channel saved.", kind: "neutral" });
    });
  }

  async function handleTeleport() {
    await run("teleport", async () => {
      const tabs = requireSelectedTabs(selectedOrCurrentTabIds());
      const currentTabId = requireCurrentTabId();
      if (!tabs.some((tab) => tab.id === currentTabId)) {
        throw new Error("Select the current tab to teleport its browser state");
      }
      await requestCapturePermissions(tabs);
      const trimmedName = resourceName.trim();
      if (destination === "snapshot" && trimmedName === "") {
        setAdvanced(true);
        throw new Error("Snapshot name is required");
      }
      const result = await teleportTabs({
        type: "teleport-tabs",
        tabIds: tabs.map(requireTabId),
        authenticatedTabId: currentTabId,
        destination,
        label: trimmedName,
        tags: entriesToTags(tags),
        ...(destination === "snapshot"
          ? { snapshotName: trimmedName, description: description.trim() }
          : {}),
      });
      resetTeleportDraft();
      const resource = destination === "snapshot" ? "Snapshot" : "Session";
      setStatus({
        message:
          result.warnings.length === 0
            ? `${resource} created.`
            : `${resource} created. ${result.warnings.join(" ")}`,
        kind: "neutral",
      });
    });
  }

  function resetTeleportDraft() {
    const currentTabIds =
      currentTab?.id === undefined || !isWebURL(currentTab.url) ? [] : [currentTab.id];
    setScreen("home");
    setSelectedTabIds(currentTabIds);
    setDraftTabIds(currentTabIds);
    setSelectedSnapshot(blankSnapshotValue);
    setDestination("session");
    setAdvanced(false);
    setResourceName(currentTab?.title?.trim() ?? "");
    setDescription("");
    setTags(defaultTags);
  }

  function handleReset() {
    resetTeleportDraft();
    setStatus(null);
  }

  function handleConfirmTabs() {
    try {
      const tabs = requireSelectedTabs(draftTabIds);
      if (!tabs.some((tab) => tab.id === requireCurrentTabId())) {
        throw new Error("The current tab must stay selected");
      }
      setSelectedTabIds(draftTabIds);
      setStatus(null);
      setScreen("home");
    } catch (error) {
      setStatus({ message: errorMessage(error), kind: "error" });
    }
  }

  function selectedOrCurrentTabIds(): number[] {
    if (selectedTabIds.length > 0) {
      return selectedTabIds;
    }
    if (currentTab?.id !== undefined && isWebURL(currentTab.url)) {
      return [currentTab.id];
    }
    return [];
  }

  async function teleportTabs(command: TeleportTabsCommand) {
    const baseSnapshotName =
      selectedSnapshot === blankSnapshotValue || snapshots === null ? undefined : selectedSnapshot;
    const response = teleportTabsResultSchema.parse(
      await chrome.runtime.sendMessage({ ...command, baseSnapshotName }),
    );
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response;
  }

  async function run(pending: PendingAction, action: () => Promise<void>) {
    setPendingAction(pending);
    setStatus(null);
    try {
      await action();
    } catch (error) {
      setStatus({ message: errorMessage(error), kind: "error" });
    } finally {
      setPendingAction(null);
    }
  }

  function requireCurrentTab(): chrome.tabs.Tab {
    if (currentTab === null || !isWebURL(currentTab.url)) {
      throw new Error("The current page cannot be teleported");
    }
    return currentTab;
  }

  function requireCurrentTabId(): number {
    return requireTabId(requireCurrentTab());
  }

  function requireSelectedTabs(tabIds: number[]): chrome.tabs.Tab[] {
    const selected = new Set(tabIds);
    const tabs = browserWindows
      .flatMap((browserWindow) => browserWindow.tabs)
      .filter((tab) => tab.id !== undefined && selected.has(tab.id));
    if (tabs.length === 0) {
      throw new Error("Select at least one tab");
    }
    return tabs;
  }

  if (!initialized) {
    return <main className="h-[34rem] w-96 p-3 text-sm text-muted-foreground">Loading…</main>;
  }

  const channelItems = connection?.channels.map((channel) => ({ value: channel, label: channel }));
  const canCreateSnapshot = connection !== null && hasScope(connection, "snapshots:write");

  return (
    <main className="flex h-[34rem] w-96 flex-col gap-4 overflow-hidden p-3">
      {screen === "home" && connection !== null ? (
        <>
          <Popover
            open={connectionMenuOpen}
            onOpenChange={(open) => {
              setConnectionMenuOpen(open);
              if (!open) {
                setPendingRemoval(null);
              }
            }}
          >
            <header className="flex items-center gap-2">
              <img src="/icon.svg" alt="Aperture" className="size-8 shrink-0" />
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="min-w-0 flex-1 justify-between"
                    disabled={busy}
                  />
                }
              >
                <span className="truncate">{connectionLabel(connection)}</span>
                {managingConnection ? (
                  <Spinner data-icon="inline-end" />
                ) : (
                  <ChevronDownIcon data-icon="inline-end" />
                )}
              </PopoverTrigger>
            </header>
            <PopoverContent
              align="start"
              className="max-h-(--available-height) w-(--anchor-width) overflow-y-auto"
            >
              <div className="flex flex-col gap-2">
                {connections.map((candidate) => (
                  <ConnectionRow
                    key={candidate.id}
                    connection={candidate}
                    active={candidate.id === connection.id}
                    disabled={busy}
                    removalPending={pendingRemoval === candidate.id}
                    onSelect={handleConnectionChange}
                    onRequestRemoval={setPendingRemoval}
                    onCancelRemoval={() => setPendingRemoval(null)}
                    onRemove={handleRemoveConnection}
                    onReorder={handleReorderConnection}
                  />
                ))}
                <Separator />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setPendingRemoval(null);
                    setConnectionMenuOpen(false);
                    setStatus(null);
                    setScreen("add-connection");
                  }}
                >
                  <PlusIcon data-icon="inline-start" />
                  Add connection
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <ScrollArea scrollbars="vertical" className="-mx-3 min-h-0 flex-1">
            <FieldGroup className="px-3 pr-4">
              <Field>
                <FieldLabel htmlFor="teleport-tabs">Tabs</FieldLabel>
                <Button
                  id="teleport-tabs"
                  type="button"
                  variant="outline"
                  className="w-full min-w-0 justify-between font-normal"
                  disabled={busy}
                  onClick={() => {
                    setDraftTabIds(selectedOrCurrentTabIds());
                    setStatus(null);
                    setScreen("tabs");
                  }}
                >
                  <span className="truncate">
                    {selectedTabsLabel(selectedOrCurrentTabIds(), currentTab, browserWindows)}
                  </span>
                  <ChevronRightIcon data-icon="inline-end" />
                </Button>
              </Field>

              <Field>
                <FieldLabel>Destination</FieldLabel>
                <ToggleGroup
                  value={[destination]}
                  variant="outline"
                  spacing={0}
                  className="w-full"
                  onValueChange={(values) => {
                    const value = values[0];
                    if (value === "session" || (value === "snapshot" && canCreateSnapshot)) {
                      setDestination(value);
                      setStatus(null);
                    }
                  }}
                >
                  <ToggleGroupItem className="flex-1" value="session" aria-label="Session">
                    Session
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    className="flex-1"
                    value="snapshot"
                    aria-label="Snapshot"
                    disabled={!canCreateSnapshot}
                    title={canCreateSnapshot ? undefined : "Requires snapshots:write"}
                  >
                    Snapshot
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <Accordion
                value={advanced ? ["advanced"] : []}
                onValueChange={(values) => setAdvanced(values.includes("advanced"))}
              >
                <AccordionItem value="advanced" className="border-none">
                  <AccordionTrigger disabled={busy}>Advanced</AccordionTrigger>
                  <AccordionContent className="pt-2 pb-0">
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="resource-name">
                          {destination === "snapshot" ? "Snapshot name" : "Session name"}
                        </FieldLabel>
                        <Input
                          id="resource-name"
                          value={resourceName}
                          placeholder={destination === "snapshot" ? "Required" : "Optional"}
                          required={destination === "snapshot"}
                          disabled={busy}
                          onChange={(event) => setResourceName(event.target.value)}
                        />
                      </Field>
                      {destination === "snapshot" ? (
                        <Field>
                          <FieldLabel htmlFor="snapshot-description">Description</FieldLabel>
                          <Textarea
                            id="snapshot-description"
                            value={description}
                            placeholder="Optional"
                            disabled={busy}
                            onChange={(event) => setDescription(event.target.value)}
                          />
                        </Field>
                      ) : null}
                      <TagEditor entries={tags} onChange={setTags} disabled={busy} />
                      <Field>
                        <FieldLabel htmlFor="browser-channel">Browser channel</FieldLabel>
                        <Select
                          items={channelItems}
                          value={connection.channel}
                          disabled={busy}
                          onValueChange={(value) => void handleChannelChange(value)}
                        >
                          <SelectTrigger id="browser-channel" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start" alignItemWithTrigger={false}>
                            <SelectGroup>
                              {connection.channels.map((channel) => (
                                <SelectItem key={channel} value={channel}>
                                  {channel}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      {snapshots === null ? null : (
                        <Field>
                          <FieldLabel htmlFor="base-snapshot">Start from snapshot</FieldLabel>
                          <Combobox
                            items={snapshots}
                            value={
                              selectedSnapshot === blankSnapshotValue ? null : selectedSnapshot
                            }
                            onValueChange={(value) => {
                              setSelectedSnapshot(
                                typeof value === "string" ? value : blankSnapshotValue,
                              );
                            }}
                          >
                            <ComboboxTrigger
                              id="base-snapshot"
                              render={
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="w-full min-w-0 justify-between"
                                  disabled={busy}
                                />
                              }
                            >
                              <span className="min-w-0 truncate">
                                {selectedSnapshot === blankSnapshotValue
                                  ? "Blank session"
                                  : selectedSnapshot}
                              </span>
                            </ComboboxTrigger>
                            <ComboboxContent
                              align="start"
                              className="w-(--anchor-width) min-w-(--anchor-width)"
                            >
                              <ComboboxInput
                                placeholder="Search snapshots"
                                showTrigger={false}
                                className="w-auto"
                              />
                              {selectedSnapshot === blankSnapshotValue ? null : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="mx-1 mt-1 justify-start"
                                  onClick={() => setSelectedSnapshot(blankSnapshotValue)}
                                >
                                  Blank session
                                </Button>
                              )}
                              <ComboboxEmpty>No snapshots found</ComboboxEmpty>
                              <ComboboxList>
                                {(snapshotName: string) => (
                                  <ComboboxItem key={snapshotName} value={snapshotName}>
                                    {snapshotName}
                                  </ComboboxItem>
                                )}
                              </ComboboxList>
                            </ComboboxContent>
                          </Combobox>
                        </Field>
                      )}
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </FieldGroup>
          </ScrollArea>

          <StatusAlert status={status} />

          <footer className="mt-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Reset"
              title="Reset"
              disabled={busy}
              onClick={handleReset}
            >
              <RefreshCwIcon />
            </Button>
            <Button type="button" className="flex-1" disabled={busy} onClick={handleTeleport}>
              {teleporting ? <Spinner data-icon="inline-start" /> : null}
              {teleportButtonLabel}
            </Button>
          </footer>
        </>
      ) : null}

      {screen === "add-connection" ? (
        <>
          <header className="flex items-center gap-2">
            {connection === null ? (
              <img src="/icon.svg" alt="Aperture" className="size-8 shrink-0" />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Back"
                title="Back"
                disabled={busy}
                onClick={() => {
                  setStatus(null);
                  setScreen("home");
                }}
              >
                <ArrowLeftIcon />
              </Button>
            )}
            <h1 className="text-base font-semibold">
              {connection === null ? "Connect to Aperture" : "Add connection"}
            </h1>
          </header>
          <ConnectionForm
            origin={origin}
            token={token}
            busy={busy}
            connecting={pendingAction === "connect"}
            status={status}
            onChange={updateConnectionDraft}
            onSubmit={handleConnect}
          />
        </>
      ) : null}

      {screen === "tabs" ? (
        <>
          <header className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Back"
              title="Back"
              disabled={busy}
              onClick={() => {
                setDraftTabIds(selectedOrCurrentTabIds());
                setStatus(null);
                setScreen("home");
              }}
            >
              <ArrowLeftIcon />
            </Button>
            <h1 className="text-base font-semibold">Select tabs</h1>
          </header>
          <FieldSet className="min-h-0 min-w-0 flex-1 gap-3">
            <ScrollArea
              scrollbars="vertical"
              className="-mx-3 -my-2 min-h-0 w-[calc(100%+1.5rem)] min-w-0 flex-1"
            >
              <div className="flex min-w-0 flex-col gap-3 pt-2">
                {browserWindows.map((browserWindow) => (
                  <FieldSet
                    key={browserWindow.id}
                    className="w-full min-w-0 max-w-full gap-1 overflow-hidden"
                  >
                    <FieldLegend
                      variant="label"
                      className="mb-0 w-full max-w-full truncate px-3 pb-1 text-xs text-muted-foreground"
                    >
                      {browserWindow.label}
                    </FieldLegend>
                    <FieldGroup
                      data-slot="checkbox-group"
                      className="min-w-0 data-[slot=checkbox-group]:gap-0"
                    >
                      {browserWindow.tabs.map((tab) => {
                        if (tab.id === undefined) {
                          return null;
                        }
                        const tabId = tab.id;
                        const inputId = `tab-${tabId}`;
                        const selected = draftTabIds.includes(tabId);
                        const current = tabId === currentTab?.id;
                        return (
                          <Field
                            key={tabId}
                            orientation="horizontal"
                            className={cn(
                              "min-w-0 items-center px-3 py-1 transition-colors hover:bg-muted/50",
                              selected && "bg-muted",
                            )}
                          >
                            <Checkbox
                              id={inputId}
                              checked={selected}
                              disabled={busy || current}
                              onCheckedChange={(checked) => {
                                setDraftTabIds((currentTabIds) =>
                                  checked
                                    ? [...new Set([...currentTabIds, tabId])]
                                    : currentTabIds.filter((id) => id !== tabId),
                                );
                              }}
                            />
                            <FieldLabel htmlFor={inputId} className="min-w-0 items-center gap-2">
                              <TabFavicon tab={tab} />
                              <span className="flex min-w-0 flex-1 flex-col gap-0">
                                <span className="truncate">
                                  {tab.title?.trim() || tab.url || "Untitled tab"}
                                </span>
                                <span className="truncate font-mono text-xs leading-tight font-normal text-muted-foreground">
                                  {tabUrlLabel(tab.url)}
                                </span>
                              </span>
                            </FieldLabel>
                          </Field>
                        );
                      })}
                    </FieldGroup>
                  </FieldSet>
                ))}
              </div>
            </ScrollArea>
            <StatusAlert status={status} />
            <Button
              type="button"
              disabled={busy || draftTabIds.length === 0}
              onClick={handleConfirmTabs}
            >
              Confirm
            </Button>
          </FieldSet>
        </>
      ) : null}
    </main>
  );
}

type ConnectionFormProps = {
  origin: string;
  token: string;
  busy: boolean;
  connecting: boolean;
  status: Status | null;
  onChange: (draft: ConnectionDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

function ConnectionForm({
  origin,
  token,
  busy,
  connecting,
  status,
  onChange,
  onSubmit,
}: ConnectionFormProps) {
  return (
    <form className="flex flex-1 flex-col" onSubmit={(event) => void onSubmit(event)}>
      <FieldGroup className="flex-1 gap-3">
        <Field>
          <FieldLabel htmlFor="origin">Aperture URL</FieldLabel>
          <Input
            id="origin"
            type="url"
            value={origin}
            placeholder="https://aperture.example.com"
            required
            disabled={busy}
            onChange={(event) => onChange({ origin: event.target.value, token })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="token">API token</FieldLabel>
          <Input
            id="token"
            type="password"
            value={token}
            autoComplete="off"
            placeholder="apt_…"
            required
            disabled={busy}
            onChange={(event) => onChange({ origin, token: event.target.value })}
          />
        </Field>
        <StatusAlert status={status} />
        <Button className="mt-auto" type="submit" disabled={busy}>
          {connecting ? <Spinner data-icon="inline-start" /> : null}
          {connecting ? "Connecting…" : "Add connection"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function StatusAlert({ status }: { status: Status | null }) {
  if (status === null) {
    return null;
  }

  return (
    <Alert variant={status.kind === "error" ? "destructive" : "default"}>
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>
  );
}

function TabFavicon({ tab }: { tab: chrome.tabs.Tab }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [tab.favIconUrl]);

  if (!tab.favIconUrl || failed) {
    return <Globe2Icon className="size-4 shrink-0 text-muted-foreground" />;
  }

  return (
    <img
      src={tab.favIconUrl}
      alt=""
      className="size-4 shrink-0 rounded-sm"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function ConnectionRow({
  connection,
  active,
  disabled,
  removalPending,
  onSelect,
  onRequestRemoval,
  onCancelRemoval,
  onRemove,
  onReorder,
}: {
  connection: Connection;
  active: boolean;
  disabled: boolean;
  removalPending: boolean;
  onSelect: (id: string) => Promise<void>;
  onRequestRemoval: (id: string) => void;
  onCancelRemoval: () => void;
  onRemove: (id: string) => Promise<void>;
  onReorder: (sourceId: string, destinationId: string, placement: DropPlacement) => Promise<void>;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const dragHandleRef = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropPlacement, setDropPlacement] = useState<DropPlacement | null>(null);
  const label = connectionLabel(connection);

  useEffect(() => {
    const element = rowRef.current;
    const dragHandle = dragHandleRef.current;
    if (element === null || dragHandle === null) {
      return;
    }

    return combine(
      draggable({
        element,
        dragHandle,
        canDrag: () => !disabled,
        getInitialData: () => ({ kind: connectionDragKind, connectionId: connection.id }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          !disabled &&
          isConnectionDragData(source.data) &&
          source.data.connectionId !== connection.id,
        getData: () => ({ kind: connectionDragKind, connectionId: connection.id }),
        onDrag: ({ location, self }) => {
          setDropPlacement(dropPlacementFromClientY(self.element, location.current.input.clientY));
        },
        onDragEnter: ({ location, self }) => {
          setDropPlacement(dropPlacementFromClientY(self.element, location.current.input.clientY));
        },
        onDragLeave: () => setDropPlacement(null),
        onDrop: ({ source, self, location }) => {
          setDropPlacement(null);
          if (!isConnectionDragData(source.data)) {
            return;
          }
          void onReorder(
            source.data.connectionId,
            connection.id,
            dropPlacementFromClientY(self.element, location.current.input.clientY),
          );
        },
      }),
    );
  }, [connection.id, disabled, onReorder]);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={rowRef}
        className={cn("relative flex items-center gap-1", dragging && "opacity-60")}
      >
        <span
          className={cn(
            "pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-primary opacity-0",
            dropPlacement === "before" && "opacity-100",
          )}
        />
        <span
          className={cn(
            "pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-primary opacity-0",
            dropPlacement === "after" && "opacity-100",
          )}
        />
        <Button
          ref={dragHandleRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="cursor-grab touch-none active:cursor-grabbing"
          aria-label={`Reorder ${label}`}
          title="Drag to reorder"
          disabled={disabled}
        >
          <GripVerticalIcon />
        </Button>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="sm"
          className="min-w-0 flex-1 justify-start"
          disabled={disabled}
          onClick={() => void onSelect(connection.id)}
        >
          <span className="truncate">{label}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${label}`}
          title="Remove"
          disabled={disabled}
          onClick={() => onRequestRemoval(connection.id)}
        >
          <Trash2Icon />
        </Button>
      </div>
      {removalPending ? (
        <div
          role="group"
          aria-label={`Confirm removal of ${label}`}
          className="flex items-center justify-between gap-2 px-2 py-1"
        >
          <p className="truncate text-xs text-muted-foreground">Remove this connection?</p>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={onCancelRemoval}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              disabled={disabled}
              onClick={() => void onRemove(connection.id)}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isConnectionDragData(data: Record<string, unknown>): data is ConnectionDragData {
  return data.kind === connectionDragKind && typeof data.connectionId === "string";
}

function dropPlacementFromClientY(element: Element, clientY: number): DropPlacement {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function groupTabsByWindow(
  windows: chrome.windows.Window[],
  currentWindowId: number | undefined,
): BrowserWindowTabs[] {
  const grouped: Array<{ id: number; tabs: chrome.tabs.Tab[] }> = [];
  for (const window of windows) {
    if (window.id === undefined) {
      continue;
    }
    const tabs = (window.tabs ?? []).filter(({ url }) => isWebURL(url));
    if (tabs.length > 0) {
      grouped.push({ id: window.id, tabs });
    }
  }

  grouped.sort((left, right) => {
    if (left.id === currentWindowId) {
      return -1;
    }
    if (right.id === currentWindowId) {
      return 1;
    }
    return 0;
  });
  return grouped.map(({ id, tabs }, index) => {
    const windowLabel = id === currentWindowId ? "Current window" : `Window ${index + 1}`;
    const activeTitle = tabs.find((tab) => tab.active)?.title?.trim();
    return {
      id,
      label: activeTitle ? `${windowLabel} · ${activeTitle}` : windowLabel,
      tabs,
    };
  });
}

function reconcileTabIds(
  tabIds: number[],
  browserWindows: BrowserWindowTabs[],
  currentTab: chrome.tabs.Tab | null,
): number[] {
  const availableTabIds = new Set(
    browserWindows.flatMap(({ tabs }) => tabs.flatMap(({ id }) => (id === undefined ? [] : [id]))),
  );
  const reconciled = [...new Set(tabIds)].filter((tabId) => availableTabIds.has(tabId));
  if (
    currentTab?.id !== undefined &&
    isWebURL(currentTab.url) &&
    availableTabIds.has(currentTab.id) &&
    !reconciled.includes(currentTab.id)
  ) {
    reconciled.unshift(currentTab.id);
  }
  return reconciled;
}

function selectedTabsLabel(
  selectedTabIds: number[],
  currentTab: chrome.tabs.Tab | null,
  browserWindows: BrowserWindowTabs[],
): string {
  if (selectedTabIds.length === 0) {
    return "Select tabs";
  }
  if (selectedTabIds.length > 1) {
    return `${selectedTabIds.length} tabs`;
  }
  const selectedTabId = selectedTabIds[0];
  if (selectedTabId === currentTab?.id) {
    return "Current tab";
  }
  const selectedTab = browserWindows
    .flatMap((browserWindow) => browserWindow.tabs)
    .find((tab) => tab.id === selectedTabId);
  return selectedTab?.title?.trim() || "1 tab";
}

function statusFromTeleportOperation(operation: TeleportOperation | null): Status | null {
  if (operation === null) {
    return null;
  }
  if (operation.status === "running") {
    return isTeleportOperationRunning(operation)
      ? null
      : { message: "The previous teleport did not complete", kind: "error" };
  }
  if (operation.status === "failed") {
    return { message: operation.error, kind: "error" };
  }
  const resource = operation.destination === "snapshot" ? "Snapshot" : "Session";
  return {
    message:
      operation.warnings.length === 0
        ? `${resource} created.`
        : `${resource} created. ${operation.warnings.join(" ")}`,
    kind: "neutral",
  };
}

function teleportProgressLabel(
  operation: TeleportOperation | null,
  pendingAction: PendingAction | null,
): string {
  if (operation?.status === "running" && isTeleportOperationRunning(operation)) {
    switch (operation.stage) {
      case "capturing":
        return "Capturing state…";
      case "creating-session":
        return "Restoring in Aperture…";
      case "creating-snapshot":
        return "Creating snapshot…";
      case "opening":
        return "Opening Aperture…";
    }
  }
  return pendingAction === "teleport" ? "Preparing…" : "Teleport";
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function requireTabId(tab: chrome.tabs.Tab): number {
  if (tab.id === undefined) {
    throw new Error("The browser tab is unavailable");
  }
  return tab.id;
}

function connectionLabel(connection: Connection): string {
  return `${connection.tenantName} · ${new URL(connection.origin).host}`;
}

function isWebURL(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function tabUrlLabel(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed";
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing companion root element");
}
createRoot(root).render(<CompanionPopup />);
