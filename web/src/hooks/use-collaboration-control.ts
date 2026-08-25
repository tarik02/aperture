import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";
import { evdevKeycodeByCode } from "#/lib/control/input-keycodes.ts";
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
  lastError: string | null;
  participants: CollaborationParticipant[];
  cursors: ReadonlyMap<string, CollaborationCursor>;
  followingClientId: string | null;
  claim: (targetId: string) => boolean;
  promote: () => boolean;
  release: () => boolean;
  take: (targetId: string) => boolean;
  setActiveTarget: (targetId: string | null) => boolean;
  follow: (clientId: string | null) => boolean;
  sendCursor: (targetId: string, x: number, y: number, dimensions: InputDimensions) => boolean;
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
  const identity = useMemo(
    () => collaborationIdentity(role, activeProfile?.tokenName ?? null),
    [activeProfile?.tokenName, role],
  );
  const [phase, setPhase] = useState<CollaborationPhase>("idle");
  const [holderClientId, setHolderClientId] = useState<string | null>(null);
  const [leaseMode, setLeaseMode] = useState<CollaborationLeaseMode | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<CollaborationParticipant[]>([]);
  const [cursors, setCursors] = useState<ReadonlyMap<string, CollaborationCursor>>(() => new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const sequenceRef = useRef(0);
  const claimPendingRef = useRef(false);
  const releasePendingRef = useRef(false);
  const textKeyCodesRef = useRef(new Set<string>());
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
      followingClientIdRef.current = null;
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) {
        return;
      }
      setPhase("connecting");
      const socket = new WebSocket(
        collaborationURL(sessionId),
        collaborationProtocols(credentials, sessionToken),
      );
      socketRef.current = socket;

      socket.addEventListener("open", () => {
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
        const message = decodeServerMessage(event.data);
        if (!message) {
          setLastError("The collaboration server sent an invalid message.");
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
            releasePendingRef.current = false;
            if (nextHolder !== clientId) {
              claimPendingRef.current = false;
              textKeyCodesRef.current.clear();
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
          case "error":
            claimPendingRef.current = false;
            setLastError(message.message);
            return;
          default: {
            const exhaustive: never = message;
            return exhaustive;
          }
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        claimPendingRef.current = false;
        textKeyCodesRef.current.clear();
        setHolderClientId(null);
        setLeaseMode(null);
        setParticipants([]);
        setCursors(new Map());
        followingClientIdRef.current = null;
        if (!disposed) {
          setPhase("disconnected");
          reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
        }
      });
      socket.addEventListener("error", () => {
        setLastError("Collaboration connection failed.");
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [clientId, credentials, enabled, identity, sessionId, sessionToken]);

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify({ version: 1, ...message }));
    return true;
  }, []);

  const claim = useCallback(
    (targetId: string) => {
      if (role === "viewer") {
        return false;
      }
      releasePendingRef.current = false;
      claimPendingRef.current = true;
      return send({ type: "input.claim", targetId });
    },
    [role, send],
  );
  const promote = useCallback(() => send({ type: "input.promote" }), [send]);
  const release = useCallback(() => {
    if (releasePendingRef.current || holderClientIdRef.current !== clientId) {
      return false;
    }
    releasePendingRef.current = true;
    claimPendingRef.current = false;
    textKeyCodesRef.current.clear();
    holderClientIdRef.current = null;
    setHolderClientId(null);
    setLeaseMode(null);
    return send({ type: "input.release" });
  }, [clientId, send]);
  const take = useCallback(
    (targetId: string) => {
      if (role !== "owner") {
        return false;
      }
      releasePendingRef.current = false;
      claimPendingRef.current = true;
      return send({ type: "input.take", targetId });
    },
    [role, send],
  );
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
            });
          }
          const count = message.action === "doubleClick" ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            sendInputEvent(message.targetId, {
              type: "input.pointer.button",
              buttonCode,
              pressed: true,
            });
            sendInputEvent(message.targetId, {
              type: "input.pointer.button",
              buttonCode,
              pressed: false,
            });
          }
          return true;
        }
        case "input.wheel":
          sendInputEvent(message.targetId, {
            type: "input.pointer.motion.absolute",
            x: normalizedCoordinate(message.x, dimensions.width),
            y: normalizedCoordinate(message.y, dimensions.height),
          });
          sendInputEvent(message.targetId, {
            type: "input.pointer.scroll",
            horizontal: message.deltaX * 0.1,
            vertical: message.deltaY * 0.1,
            stopHorizontal: false,
            stopVertical: false,
          });
          return sendInputEvent(message.targetId, {
            type: "input.pointer.scroll",
            horizontal: 0,
            vertical: 0,
            stopHorizontal: message.deltaX !== 0,
            stopVertical: message.deltaY !== 0,
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
          if (message.action === "down" && message.text) {
            if (message.code) {
              textKeyCodesRef.current.add(message.code);
            }
            return sendInputEvent(message.targetId, {
              type: "input.keyboard.text",
              text: message.text,
            });
          }
          if (
            message.action === "up" &&
            message.code &&
            textKeyCodesRef.current.delete(message.code)
          ) {
            return true;
          }
          const keycode = evdevKeycodeByCode[message.code ?? ""];
          return keycode
            ? sendInputEvent(message.targetId, {
                type: "input.keyboard.key",
                keycode,
                pressed: message.action === "down",
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
    followingClientId,
    claim,
    promote,
    release,
    take,
    setActiveTarget,
    follow,
    sendCursor,
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
    name: accountName.trim().slice(0, 48),
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
  return Math.min(1, Math.max(0, value / (length - 1)));
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
  sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: controlKeycode,
    pressed: true,
  });
  sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: shortcutKeycode,
    pressed: true,
  });
  sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: shortcutKeycode,
    pressed: false,
  });
  return sendInputEvent(targetId, {
    type: "input.keyboard.key",
    keycode: controlKeycode,
    pressed: false,
  });
}
