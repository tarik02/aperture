import { useEffect, useRef, useSyncExternalStore, type MouseEvent } from "react";

// Workbench tabs announce the session they show over a BroadcastChannel, so the session list can
// mark open sessions and focus the tab that already shows one instead of opening a duplicate.

type OpenSessionMessage =
  | { type: "open"; tabId: string; sessionId: string; targetId: string | null }
  | { type: "closed"; tabId: string }
  | { type: "query" }
  | { type: "select-target"; sessionId: string; targetId: string };

interface OpenTab {
  readonly sessionId: string;
  readonly targetId: string | null;
  readonly seenAt: number;
}

export interface OpenSessionInfo {
  readonly tabs: number;
  readonly targetIds: ReadonlySet<string>;
}

const channelName = "aperture-open-sessions";
const heartbeatMs = 5_000;
const staleMs = 3 * heartbeatMs;
const emptyOpenSessions: ReadonlyMap<string, OpenSessionInfo> = new Map();

const tabs = new Map<string, OpenTab>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, OpenSessionInfo> = emptyOpenSessions;
let channel: BroadcastChannel | null = null;
let pruneTimer: number | null = null;

function rebuildSnapshot() {
  const now = Date.now();
  const next = new Map<string, { tabs: number; targetIds: Set<string> }>();
  for (const [tabId, tab] of tabs) {
    if (now - tab.seenAt > staleMs) {
      tabs.delete(tabId);
      continue;
    }
    const entry = next.get(tab.sessionId) ?? { tabs: 0, targetIds: new Set<string>() };
    entry.tabs += 1;
    if (tab.targetId) {
      entry.targetIds.add(tab.targetId);
    }
    next.set(tab.sessionId, entry);
  }
  snapshot = next.size === 0 ? emptyOpenSessions : next;
  for (const listener of listeners) {
    listener();
  }
}

function openChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") {
    return channel;
  }
  channel = new BroadcastChannel(channelName);
  channel.addEventListener("message", (event: MessageEvent<OpenSessionMessage>) => {
    const message = event.data;
    if (message.type === "open") {
      tabs.set(message.tabId, {
        sessionId: message.sessionId,
        targetId: message.targetId,
        seenAt: Date.now(),
      });
      rebuildSnapshot();
    } else if (message.type === "closed") {
      tabs.delete(message.tabId);
      rebuildSnapshot();
    }
  });
  return channel;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const refresh = () => {
      // Background tabs throttle their heartbeat timers but answer messages right away.
      openChannel()?.postMessage({ type: "query" } satisfies OpenSessionMessage);
      rebuildSnapshot();
    };
    refresh();
    pruneTimer = window.setInterval(refresh, heartbeatMs);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pruneTimer !== null) {
      window.clearInterval(pruneTimer);
      pruneTimer = null;
    }
  };
}

/** Sessions shown by workbench tabs of this browser, other than the current tab. */
export function useOpenSessions(): ReadonlyMap<string, OpenSessionInfo> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => emptyOpenSessions,
  );
}

const sessionWindowPrefix = "aperture-session-";

export function sessionWindowName(sessionId: string) {
  return `${sessionWindowPrefix}${sessionId}`;
}

/**
 * Announces the session this workbench tab shows. The window is named after the session, so
 * opening it from another tab reaches this one.
 */
export function useAnnounceOpenSession(
  sessionId: string | null,
  targetId: string | null,
  onSelectTarget: (targetId: string) => void,
) {
  const onSelectTargetRef = useRef(onSelectTarget);
  onSelectTargetRef.current = onSelectTarget;
  const targetIdRef = useRef(targetId);
  targetIdRef.current = targetId;
  const announceRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    announceRef.current?.();
  }, [targetId]);

  useEffect(() => {
    const broadcast = openChannel();
    if (!sessionId || !broadcast) {
      return;
    }
    const tabId = crypto.randomUUID();
    const previousName = window.name;
    window.name = sessionWindowName(sessionId);
    const announce = () =>
      broadcast.postMessage({
        type: "open",
        tabId,
        sessionId,
        targetId: targetIdRef.current,
      } satisfies OpenSessionMessage);
    announceRef.current = announce;
    const handleMessage = (event: MessageEvent<OpenSessionMessage>) => {
      const message = event.data;
      if (message.type === "query") {
        announce();
      } else if (message.type === "select-target" && message.sessionId === sessionId) {
        onSelectTargetRef.current(message.targetId);
      }
    };
    const closed = () =>
      broadcast.postMessage({ type: "closed", tabId } satisfies OpenSessionMessage);

    announce();
    const heartbeat = window.setInterval(announce, heartbeatMs);
    broadcast.addEventListener("message", handleMessage);
    window.addEventListener("pagehide", closed);
    return () => {
      window.clearInterval(heartbeat);
      broadcast.removeEventListener("message", handleMessage);
      window.removeEventListener("pagehide", closed);
      closed();
      announceRef.current = null;
      // A tab opened for this session was born with its name; keeping it would route later
      // opens of the session here after the tab moved on.
      window.name = previousName.startsWith(sessionWindowPrefix) ? "" : previousName;
    };
  }, [sessionId]);
}

/**
 * Opens a session in its own tab, or focuses the tab that already shows it. A window opened
 * by name only reaches tabs this page opened, so a tab the user opened by hand gets a second one.
 */
export function openSessionTab(sessionId: string, href: string, targetId?: string) {
  const existing = window.open("", sessionWindowName(sessionId));
  if (!existing) {
    return;
  }
  let showsSession = false;
  try {
    showsSession = existing.location.pathname === new URL(href, window.location.origin).pathname;
  } catch {
    // Another origin: treat it as not showing the session.
  }
  if (!showsSession) {
    existing.location.href = href;
    existing.focus();
    return;
  }
  if (targetId) {
    openChannel()?.postMessage({
      type: "select-target",
      sessionId,
      targetId,
    } satisfies OpenSessionMessage);
  }
  existing.focus();
}

/**
 * Click semantics for links that open a session: a plain click navigates in place,
 * Ctrl/Cmd+click or a middle click opens a new tab, and a session already open in another tab
 * is focused there instead of opening twice.
 */
export function sessionLinkHandlers(options: {
  sessionId: string;
  href: string;
  targetId?: string;
  isOpenElsewhere: boolean;
  onNavigate: () => void;
}) {
  const { sessionId, href, targetId, isOpenElsewhere, onNavigate } = options;
  return {
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }
      event.preventDefault();
      if (event.ctrlKey || event.metaKey || event.shiftKey || isOpenElsewhere) {
        openSessionTab(sessionId, href, targetId);
        return;
      }
      onNavigate();
    },
    onAuxClick: (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      openSessionTab(sessionId, href, targetId);
    },
  };
}

export function sessionHref(sessionId: string, targetId?: string, newTab?: boolean) {
  const url = new URL(`/-/sessions/${encodeURIComponent(sessionId)}`, window.location.origin);
  if (newTab) {
    url.searchParams.set("newTab", "1");
  }
  if (targetId) {
    url.hash = new URLSearchParams({ target: targetId }).toString();
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
