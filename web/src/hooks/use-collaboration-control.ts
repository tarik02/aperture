import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Subject, type Observable } from "rxjs";
import { z } from "zod";
import { resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";
import { evdevKeycodeByCode } from "#/lib/control/input-keycodes.ts";
import { windowsVirtualKeyCodeForCodeOrKey } from "#/lib/control/keyboard.ts";
import type { ClientMessage } from "#/lib/control/messages.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export type CollaborationRole = "owner" | "editor" | "viewer";
export type CollaborationLeaseMode = "implicit" | "explicit";
export type CollaborationPhase = "idle" | "connecting" | "connected" | "disconnected";

export type CollaborationParticipant = {
  clientId: string;
  name: string;
  avatarHash: string;
  role: CollaborationRole;
  activeTargetId?: string;
  followingClientId?: string;
  holdingInput: boolean;
  leaseMode?: CollaborationLeaseMode;
};

export type CollaborationCursor = {
  clientId: string;
  targetId: string;
  x: number;
  y: number;
};

export type CollaborationPaintPhase = "start" | "move" | "end";

export type CollaborationPaintPoint = {
  targetId: string;
  strokeId: string;
  color: string;
  width: number;
  phase: CollaborationPaintPhase;
  x: number;
  y: number;
};

export type CollaborationPaintEvent =
  | { type: "point"; message: CollaborationPaintPoint & { clientId: string } }
  | { type: "clear" };

export type CollaborationError = {
  code: string;
  message: string;
};

type BrowserInputMessage = Extract<
  ClientMessage,
  {
    type:
      | "input.mouse"
      | "input.wheel"
      | "input.key"
      | "clipboard.copy"
      | "clipboard.cut"
      | "clipboard.paste";
  }
>;

type InputDimensions = {
  width: number;
  height: number;
};

export type CollaborationControl = {
  phase: CollaborationPhase;
  role: CollaborationRole;
  clientId: string;
  holderClientId: string | null;
  leaseMode: CollaborationLeaseMode | null;
  hasControl: boolean;
  canRequestControl: boolean;
  lastError: CollaborationError | null;
  participants: CollaborationParticipant[];
  cursors: ReadonlyMap<string, CollaborationCursor>;
  paintEvents: Observable<CollaborationPaintEvent>;
  followingClientId: string | null;
  claim: (targetId: string, mode: CollaborationLeaseMode) => boolean;
  release: () => boolean;
  setActiveTarget: (targetId: string | null) => boolean;
  follow: (clientId: string | null) => boolean;
  sendCursor: (targetId: string, x: number, y: number, dimensions: InputDimensions) => boolean;
  sendPaintPoint: (point: CollaborationPaintPoint) => boolean;
  sendInput: (message: BrowserInputMessage, dimensions: InputDimensions) => boolean;
};

type UseCollaborationControlOptions = {
  sessionId: string | null;
  credentials: ApiCredentials | null;
  sessionToken?: string;
  role: CollaborationRole;
  enabled: boolean;
};

const collaborationServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("presence.state"),
      participants: z.array(
        z
          .object({
            clientId: z.string(),
            name: z.string(),
            avatarHash: z.string(),
            role: z.enum(["owner", "editor", "viewer"]),
            activeTargetId: z.string().optional(),
            followingClientId: z.string().optional(),
            holdingInput: z.boolean(),
            leaseMode: z.enum(["implicit", "explicit"]).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("presence.cursor"),
      clientId: z.string(),
      targetId: z.string(),
      x: z.number().min(0).max(1).optional().default(0),
      y: z.number().min(0).max(1).optional().default(0),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("paint.point"),
      clientId: z.string(),
      targetId: z.string(),
      strokeId: z.string(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      width: z.number().min(1).max(16),
      phase: z.enum(["start", "move", "end"]),
      x: z.number().min(0).max(1).optional().default(0),
      y: z.number().min(0).max(1).optional().default(0),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("welcome"),
      clientId: z.string(),
      role: z.enum(["owner", "editor", "viewer"]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("input.state"),
      holderClientId: z.string().optional(),
      mode: z.enum(["implicit", "explicit"]).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("error"),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
]);

const collaborationProtocol = "aperture-collaboration.v1";
const heartbeatIntervalMs = 2_000;
const reconnectDelayMs = 1_000;
const cursorIntervalMs = 40;
export const collaborationPaintLifetimeMs = 7_000;
const pointerButtonCode = {
  left: 272,
  right: 273,
  middle: 274,
} as const;

export function useCollaborationControl({
  sessionId,
  credentials,
  sessionToken,
  role,
  enabled,
}: UseCollaborationControlOptions): CollaborationControl {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const clientId = useMemo(loadCollaborationClientId, []);
  const paintEventSubject = useMemo(() => new Subject<CollaborationPaintEvent>(), []);
  const identity = useMemo(
    () => collaborationIdentity(role, activeProfile?.tokenName ?? null),
    [activeProfile?.tokenName, role],
  );
  const [phase, setPhase] = useState<CollaborationPhase>("idle");
  const [holderClientId, setHolderClientId] = useState<string | null>(null);
  const [leaseMode, setLeaseMode] = useState<CollaborationLeaseMode | null>(null);
  const [lastError, setLastError] = useState<CollaborationError | null>(null);
  const [participants, setParticipants] = useState<CollaborationParticipant[]>([]);
  const [cursors, setCursors] = useState<ReadonlyMap<string, CollaborationCursor>>(() => new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const sequenceRef = useRef(0);
  const claimPendingRef = useRef(false);
  const releasePendingRef = useRef(false);
  const holderClientIdRef = useRef<string | null>(null);
  const followingClientIdRef = useRef<string | null>(null);
  const lastCursorSentAtRef = useRef(0);

  holderClientIdRef.current = holderClientId;

  useEffect(() => {
    if (!enabled || !sessionId || !credentials) {
      socketRef.current?.close();
      socketRef.current = null;
      setPhase("idle");
      setHolderClientId(null);
      setLeaseMode(null);
      setLastError(null);
      setParticipants([]);
      setCursors(new Map());
      paintEventSubject.next({ type: "clear" });
      followingClientIdRef.current = null;
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let activeSocket: WebSocket | null = null;

    const connect = () => {
      if (disposed) {
        return;
      }
      setPhase("connecting");
      const socket = new WebSocket(
        collaborationURL(sessionId),
        collaborationProtocols(credentials, sessionToken),
      );
      activeSocket = socket;
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        socket.send(
          JSON.stringify({
            version: 1,
            type: "hello",
            clientId,
            name: identity.name,
            avatarHash: identity.avatarHash,
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        const message = decodeServerMessage(event.data);
        if (!message) {
          setLastError({
            code: "invalid_server_message",
            message: "The collaboration server sent an invalid message.",
          });
          return;
        }
        switch (message.type) {
          case "welcome":
            setPhase("connected");
            setLastError(null);
            return;
          case "input.state": {
            const nextHolder = message.holderClientId ?? null;
            holderClientIdRef.current = nextHolder;
            setHolderClientId(nextHolder);
            setLeaseMode(message.mode ?? null);
            setLastError((current) =>
              current?.code === "input_busy" ||
              current?.code === "input_not_owned" ||
              current?.code === "input_unavailable"
                ? null
                : current,
            );
            releasePendingRef.current = false;
            if (nextHolder !== clientId) {
              claimPendingRef.current = false;
            }
            return;
          }
          case "presence.state":
            setLastError(null);
            setParticipants(message.participants);
            followingClientIdRef.current =
              message.participants.find((participant) => participant.clientId === clientId)
                ?.followingClientId ?? null;
            setCursors((current) => {
              const next = new Map<string, CollaborationCursor>();
              const followedCursor = followingClientIdRef.current
                ? current.get(followingClientIdRef.current)
                : null;
              if (followedCursor) {
                next.set(followedCursor.clientId, followedCursor);
              }
              return next.size === current.size ? current : next;
            });
            return;
          case "presence.cursor":
            if (message.clientId !== followingClientIdRef.current) {
              return;
            }
            setCursors((current) => {
              const next = new Map(current);
              next.set(message.clientId, message);
              return next;
            });
            return;
          case "paint.point":
            paintEventSubject.next({
              type: "point",
              message: {
                clientId: message.clientId,
                targetId: message.targetId,
                strokeId: message.strokeId,
                color: message.color,
                width: message.width,
                phase: message.phase,
                x: message.x,
                y: message.y,
              },
            });
            return;
          case "error":
            claimPendingRef.current = false;
            releasePendingRef.current = false;
            setLastError({ code: message.code, message: message.message });
            return;
          default: {
            const exhaustive: never = message;
            return exhaustive;
          }
        }
      });
      socket.addEventListener("close", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        activeSocket = null;
        socketRef.current = null;
        claimPendingRef.current = false;
        releasePendingRef.current = false;
        setHolderClientId(null);
        setLeaseMode(null);
        setParticipants([]);
        setCursors(new Map());
        paintEventSubject.next({ type: "clear" });
        followingClientIdRef.current = null;
        if (!disposed) {
          setPhase("disconnected");
          reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
        }
      });
      socket.addEventListener("error", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        setLastError({
          code: "connection_failed",
          message: "Collaboration connection failed.",
        });
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      const socket = activeSocket;
      activeSocket = null;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket?.close();
    };
  }, [clientId, credentials, enabled, identity, paintEventSubject, sessionId, sessionToken]);

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify({ version: 1, ...message }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const claim = useCallback(
    (targetId: string, mode: CollaborationLeaseMode) => {
      if (role === "viewer") {
        return false;
      }
      if (!send({ type: "input.claim", targetId, mode })) {
        return false;
      }
      releasePendingRef.current = false;
      claimPendingRef.current = true;
      return true;
    },
    [role, send],
  );
  const release = useCallback(() => {
    if (releasePendingRef.current || holderClientIdRef.current !== clientId) {
      return false;
    }
    if (!send({ type: "input.release" })) {
      return false;
    }
    releasePendingRef.current = true;
    claimPendingRef.current = false;
    return true;
  }, [clientId, send]);
  const setActiveTarget = useCallback(
    (targetId: string | null) => send({ type: "presence.active-target", targetId: targetId ?? "" }),
    [send],
  );
  const follow = useCallback(
    (followingClientId: string | null) =>
      send({ type: "follow.set", followingClientId: followingClientId ?? "" }),
    [send],
  );
  const sendCursor = useCallback(
    (targetId: string, x: number, y: number, dimensions: InputDimensions) => {
      const now = performance.now();
      if (now - lastCursorSentAtRef.current < cursorIntervalMs) {
        return false;
      }
      lastCursorSentAtRef.current = now;
      return send({
        type: "presence.cursor",
        targetId,
        x: normalizedCoordinate(x, dimensions.width),
        y: normalizedCoordinate(y, dimensions.height),
      });
    },
    [send],
  );
  const sendPaintPoint = useCallback(
    (point: CollaborationPaintPoint) => send({ type: "paint.point", ...point }),
    [send],
  );

  const sendInputEvent = useCallback(
    (targetId: string, message: Record<string, unknown>) => {
      sequenceRef.current += 1;
      return send({ ...message, targetId, sequence: sequenceRef.current });
    },
    [send],
  );

  const sendInput = useCallback(
    (message: BrowserInputMessage, dimensions: InputDimensions) => {
      if (
        role === "viewer" ||
        (holderClientIdRef.current !== clientId && !claimPendingRef.current)
      ) {
        return false;
      }
      switch (message.type) {
        case "input.mouse": {
          const x = normalizedCoordinate(message.x, dimensions.width);
          const y = normalizedCoordinate(message.y, dimensions.height);
          if (
            !sendInputEvent(message.targetId, {
              type: "input.pointer.motion.absolute",
              x,
              y,
              width: dimensions.width,
              height: dimensions.height,
              modifiers: message.modifiers ?? 0,
            })
          ) {
            return false;
          }
          if (message.action === "move" || message.button === "none") {
            return true;
          }
          const buttonCode = pointerButtonCode[message.button ?? "left"];
          if (message.action === "down" || message.action === "up") {
            return sendInputEvent(message.targetId, {
              type: "input.pointer.button",
              buttonCode,
              pressed: message.action === "down",
              clickCount: message.clickCount ?? 1,
              modifiers: message.modifiers ?? 0,
            });
          }
          const count = message.action === "doubleClick" ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            const clickCount =
              message.action === "doubleClick" ? index + 1 : (message.clickCount ?? 1);
            sendInputEvent(message.targetId, {
              type: "input.pointer.button",
              buttonCode,
              pressed: true,
              clickCount,
              modifiers: message.modifiers ?? 0,
            });
            sendInputEvent(message.targetId, {
              type: "input.pointer.button",
              buttonCode,
              pressed: false,
              clickCount,
              modifiers: message.modifiers ?? 0,
            });
          }
          return true;
        }
        case "input.wheel":
          sendInputEvent(message.targetId, {
            type: "input.pointer.motion.absolute",
            x: normalizedCoordinate(message.x, dimensions.width),
            y: normalizedCoordinate(message.y, dimensions.height),
            width: dimensions.width,
            height: dimensions.height,
            modifiers: message.modifiers ?? 0,
          });
          sendInputEvent(message.targetId, {
            type: "input.pointer.scroll",
            horizontal: message.deltaX * 0.1,
            vertical: message.deltaY * 0.1,
            stopHorizontal: false,
            stopVertical: false,
            modifiers: message.modifiers ?? 0,
          });
          return sendInputEvent(message.targetId, {
            type: "input.pointer.scroll",
            horizontal: 0,
            vertical: 0,
            stopHorizontal: message.deltaX !== 0,
            stopVertical: message.deltaY !== 0,
            modifiers: message.modifiers ?? 0,
          });
        case "input.key": {
          if (message.action === "char") {
            return message.text
              ? sendInputEvent(message.targetId, {
                  type: "input.keyboard.text",
                  text: message.text,
                })
              : false;
          }
          const keycode = evdevKeycodeByCode[message.code ?? ""];
          const windowsVirtualKeyCode =
            message.windowsVirtualKeyCode ??
            windowsVirtualKeyCodeForCodeOrKey(message.code, message.key);
          return keycode
            ? sendInputEvent(message.targetId, {
                type: "input.keyboard.key",
                keycode,
                pressed: message.action === "down",
                key: message.key,
                code: message.code,
                text: message.text,
                unmodifiedText: message.unmodifiedText,
                modifiers: message.modifiers ?? 0,
                windowsVirtualKeyCode,
                nativeVirtualKeyCode: message.nativeVirtualKeyCode ?? windowsVirtualKeyCode,
                location: message.location ?? 0,
                autoRepeat: message.autoRepeat ?? false,
                isKeypad: message.isKeypad ?? false,
              })
            : false;
        }
        case "clipboard.copy":
          return sendShortcut(sendInputEvent, message.targetId, "KeyC");
        case "clipboard.cut":
          return sendShortcut(sendInputEvent, message.targetId, "KeyX");
        case "clipboard.paste": {
          const item = message.items.find((candidate) => candidate.mimeType === "text/plain");
          return item
            ? sendInputEvent(message.targetId, {
                type: "input.keyboard.text",
                text: item.data,
              })
            : false;
        }
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    },
    [clientId, role, sendInputEvent],
  );

  const hasControl = holderClientId === clientId;
  const followingClientId =
    participants.find((participant) => participant.clientId === clientId)?.followingClientId ??
    null;
  useEffect(() => {
    if (!hasControl) {
      return;
    }
    const timer = window.setInterval(() => {
      if (holderClientIdRef.current === clientId) {
        send({ type: "input.heartbeat" });
      }
    }, heartbeatIntervalMs);
    return () => window.clearInterval(timer);
  }, [clientId, hasControl, send]);

  return {
    phase,
    role,
    clientId,
    holderClientId,
    leaseMode,
    hasControl,
    canRequestControl: role !== "viewer" && phase === "connected",
    lastError,
    participants,
    cursors,
    paintEvents: paintEventSubject,
    followingClientId,
    claim,
    release,
    setActiveTarget,
    follow,
    sendCursor,
    sendPaintPoint,
    sendInput,
  };
}

const storedIdentitySchema = z
  .object({
    name: z.string().min(1).max(48),
    avatarHash: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

function collaborationIdentity(role: CollaborationRole, accountName: string | null) {
  const anonymous = loadAnonymousIdentity();
  if (role !== "owner" || !accountName?.trim()) {
    return anonymous;
  }
  return {
    ...anonymous,
    name: Array.from(accountName.trim()).slice(0, 48).join(""),
  };
}

function loadAnonymousIdentity() {
  const storageKey = "aperture.collaboration.identity";
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) {
      const parsed = storedIdentitySchema.safeParse(JSON.parse(stored) as unknown);
      if (parsed.success) {
        return parsed.data;
      }
    }
    const created = createAnonymousIdentity();
    window.localStorage.setItem(storageKey, JSON.stringify(created));
    return created;
  } catch {
    return createAnonymousIdentity();
  }
}

function createAnonymousIdentity() {
  const adjectives = ["Amber", "Brisk", "Calm", "Clever", "Misty", "Quiet", "Swift", "Warm"];
  const animals = ["Badger", "Falcon", "Fox", "Koala", "Otter", "Panda", "Raven", "Tiger"];
  const random = new Uint8Array(18);
  crypto.getRandomValues(random);
  const adjective = adjectives[random[0]! % adjectives.length]!;
  const animal = animals[random[1]! % animals.length]!;
  return {
    name: `${adjective} ${animal}`,
    avatarHash: Array.from(random.slice(2), (value) => value.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}

function collaborationURL(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sessions/${encodeURIComponent(sessionId)}/collaboration`;
}

function collaborationProtocols(credentials: ApiCredentials, sessionToken?: string) {
  const protocols = [collaborationProtocol];
  if (sessionToken) {
    protocols.push(`authorization.bearer.${sessionToken}`);
  } else if (credentials.credentialType === "api_token") {
    protocols.push(`authorization.bearer.${credentials.token}`);
  }
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return protocols;
}

function loadCollaborationClientId() {
  return crypto.randomUUID();
}

function decodeServerMessage(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return collaborationServerMessageSchema.parse(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function normalizedCoordinate(value: number, length: number) {
  if (length <= 1) {
    return 0;
  }
  return Math.min(1, Math.max(0, value / length));
}

function sendShortcut(
  sendInputEvent: (targetId: string, message: Record<string, unknown>) => boolean,
  targetId: string,
  code: "KeyC" | "KeyX",
) {
  const controlKeycode = evdevKeycodeByCode.ControlLeft;
  const shortcutKeycode = evdevKeycodeByCode[code];
  if (!controlKeycode || !shortcutKeycode) {
    return false;
  }
  const controlVirtualKeyCode = windowsVirtualKeyCodeForCodeOrKey("ControlLeft", "Control");
  const shortcutKey = code === "KeyC" ? "c" : "x";
  const shortcutVirtualKeyCode = windowsVirtualKeyCodeForCodeOrKey(code, shortcutKey);
  sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: controlKeycode,
    pressed: true,
    key: "Control",
    code: "ControlLeft",
    modifiers: 2,
    windowsVirtualKeyCode: controlVirtualKeyCode,
    nativeVirtualKeyCode: controlVirtualKeyCode,
    location: 1,
    autoRepeat: false,
    isKeypad: false,
  });
  sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: shortcutKeycode,
    pressed: true,
    key: shortcutKey,
    code,
    modifiers: 2,
    windowsVirtualKeyCode: shortcutVirtualKeyCode,
    nativeVirtualKeyCode: shortcutVirtualKeyCode,
    location: 0,
    autoRepeat: false,
    isKeypad: false,
  });
  sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: shortcutKeycode,
    pressed: false,
    key: shortcutKey,
    code,
    modifiers: 2,
    windowsVirtualKeyCode: shortcutVirtualKeyCode,
    nativeVirtualKeyCode: shortcutVirtualKeyCode,
    location: 0,
    autoRepeat: false,
    isKeypad: false,
  });
  return sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: controlKeycode,
    pressed: false,
    key: "Control",
    code: "ControlLeft",
    modifiers: 0,
    windowsVirtualKeyCode: controlVirtualKeyCode,
    nativeVirtualKeyCode: controlVirtualKeyCode,
    location: 1,
    autoRepeat: false,
    isKeypad: false,
  });
}
