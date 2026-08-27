import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BehaviorSubject, Subject, type Observable } from "rxjs";
import { z } from "zod";
import type { ApiCredentials } from "#/lib/api/client.ts";
import type { Recording } from "#/lib/api/schemas.ts";
import type { BrowserInputMessage } from "#/lib/control/browser-input.ts";
import { evdevKeycodeByCode } from "#/lib/control/input-keycodes.ts";
import { windowsVirtualKeyCodeForCodeOrKey } from "#/lib/control/keyboard.ts";
import { LiveSessionConnection } from "#/lib/control/live-session-connection.ts";
import {
  type CollaborationCursor,
  type CollaborationError,
  type CollaborationLeaseMode,
  type CollaborationPaintEvent,
  type CollaborationPaintPoint,
  type CollaborationParticipant,
  type CollaborationPhase,
  type CollaborationRole,
  type LiveSessionPresentation,
  type LiveSessionPresentationQuality,
  type LiveSessionRasterFrame,
  type LiveSessionServerMessage,
  type LiveSessionTarget,
} from "#/lib/control/live-session-protocol.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

type InputDimensions = {
  width: number;
  height: number;
};

export type LiveSessionMediaSize = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  canvasWidth: number;
  canvasHeight: number;
};

export type LiveSessionMediaSelection =
  | { kind: "jpeg" }
  | { kind: "webrtc"; quality: LiveSessionPresentationQuality }
  | { kind: "webrtc-retry" };

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
  clearCursor: () => boolean;
  sendInput: (message: BrowserInputMessage, dimensions: InputDimensions) => boolean;
};

type UseLiveSessionOptions = {
  sessionId: string | null;
  credentials: ApiCredentials | null;
  sessionToken?: string;
  role: CollaborationRole;
  enabled: boolean;
  webrtcSupported: boolean;
  iceServers: RTCIceServer[];
};

export type LiveSessionControl = {
  phase: "idle" | "connecting" | "connected" | "disconnected" | "error";
  targets: LiveSessionTarget[];
  activeTargetId: string | null;
  frame$: Observable<LiveSessionRasterFrame | null>;
  mediaStream: MediaStream | null;
  mediaSize: LiveSessionMediaSize | null;
  transport: "webrtc" | "websocket" | null;
  presentation: LiveSessionPresentation | null;
  mediaSwitching: boolean;
  recordings: Recording[];
  collaboration: CollaborationControl;
  sendBrowserInput: (message: BrowserInputMessage, dimensions: InputDimensions) => boolean;
  selectTarget: (targetId: string) => boolean;
  command: (type: string, payload?: Record<string, unknown>) => boolean;
  request: (
    type: string,
    payload?: Record<string, unknown>,
  ) => ReturnType<LiveSessionConnection["command"]>;
  selectPresentation: (selection: LiveSessionMediaSelection) => Promise<void>;
  reconnect: () => void;
};

const heartbeatIntervalMs = 2_000;
const cursorIntervalMs = 40;
export const collaborationPaintLifetimeMs = 7_000;
const pointerButtonCode: Record<"left" | "right" | "middle", number> = {
  left: 272,
  right: 273,
  middle: 274,
};

export function useLiveSession({
  sessionId,
  credentials,
  sessionToken,
  role,
  enabled,
  webrtcSupported,
  iceServers,
}: UseLiveSessionOptions): LiveSessionControl {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const identity = useMemo(
    () => collaborationIdentity(role, activeProfile?.tokenName ?? null),
    [activeProfile?.tokenName, role],
  );
  const frameSubject = useMemo(() => new BehaviorSubject<LiveSessionRasterFrame | null>(null), []);
  const paintSubject = useMemo(() => new Subject<CollaborationPaintEvent>(), []);
  const connectionRef = useRef<LiveSessionConnection | null>(null);
  const holderClientIdRef = useRef<string | null>(null);
  const clientIdRef = useRef("");
  const claimPendingRef = useRef(false);
  const releasePendingRef = useRef(false);
  const cursorVisibleRef = useRef(false);
  const lastCursorSentAtRef = useRef(0);
  const participantsRef = useRef<CollaborationParticipant[]>([]);
  const followingClientIdRef = useRef<string | null>(null);
  const mediaSizeRef = useRef<LiveSessionMediaSize | null>(null);
  const transportRef = useRef<LiveSessionControl["transport"]>(null);
  const presentationRef = useRef<LiveSessionPresentation | null>(null);
  const presentationSelectionRef = useRef<Promise<void> | null>(null);

  const [phase, setPhase] = useState<LiveSessionControl["phase"]>("idle");
  const [targets, setTargets] = useState<LiveSessionTarget[]>([]);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [mediaSize, setMediaSize] = useState<LiveSessionMediaSize | null>(null);
  const [transport, setTransport] = useState<LiveSessionControl["transport"]>(null);
  const [targetSwitching, setTargetSwitching] = useState(false);
  const [presentationSwitching, setPresentationSwitching] = useState(false);
  const [presentation, setPresentation] = useState<LiveSessionPresentation | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [clientId, setClientId] = useState("");
  const [holderClientId, setHolderClientId] = useState<string | null>(null);
  const [leaseMode, setLeaseMode] = useState<CollaborationLeaseMode | null>(null);
  const [participants, setParticipants] = useState<CollaborationParticipant[]>([]);
  const [cursors, setCursors] = useState<ReadonlyMap<string, CollaborationCursor>>(() => new Map());
  const [lastError, setLastError] = useState<CollaborationError | null>(null);

  mediaSizeRef.current = mediaSize;
  transportRef.current = transport;
  presentationRef.current = presentation;

  const handleMessage = useCallback(
    (message: LiveSessionServerMessage) => {
      switch (message.type) {
        case "session.snapshot":
          clientIdRef.current = message.clientId;
          setClientId(message.clientId);
          holderClientIdRef.current = message.holderClientId ?? null;
          setHolderClientId(message.holderClientId ?? null);
          setLeaseMode(message.mode ?? null);
          participantsRef.current = message.participants;
          setParticipants(message.participants);
          followingClientIdRef.current =
            message.participants.find((participant) => participant.clientId === message.clientId)
              ?.followingClientId ?? null;
          setTargets(message.targets);
          setActiveTargetId(message.activeTargetId ?? null);
          setMediaSize(resolveMediaSize(message.targets, message.activeTargetId));
          setRecordings(message.recordings);
          setPresentation(message.presentation ?? null);
          setLastError(null);
          return;
        case "targets.state":
          setTargets(message.targets);
          setActiveTargetId(message.activeTargetId ?? null);
          setMediaSize(resolveMediaSize(message.targets, message.activeTargetId));
          setTargetSwitching(false);
          return;
        case "presence.state": {
          participantsRef.current = message.participants;
          setParticipants(message.participants);
          followingClientIdRef.current =
            message.participants.find((participant) => participant.clientId === clientIdRef.current)
              ?.followingClientId ?? null;
          setCursors((current) => {
            const followed = followingClientIdRef.current;
            if (!followed) {
              return current.size === 0 ? current : new Map();
            }
            const cursor = current.get(followed);
            return cursor ? new Map([[followed, cursor]]) : new Map();
          });
          return;
        }
        case "input.state":
          holderClientIdRef.current = message.holderClientId ?? null;
          setHolderClientId(message.holderClientId ?? null);
          setLeaseMode(message.mode ?? null);
          claimPendingRef.current = false;
          releasePendingRef.current = false;
          setLastError((current) =>
            current?.code === "input_busy" || current?.code === "input_not_owned" ? null : current,
          );
          return;
        case "presence.cursor":
          if (message.clientId !== followingClientIdRef.current) {
            return;
          }
          setCursors((current) => new Map(current).set(message.clientId, message));
          return;
        case "presence.cursor.clear":
          setCursors((current) => {
            if (!current.has(message.clientId)) {
              return current;
            }
            const next = new Map(current);
            next.delete(message.clientId);
            return next;
          });
          return;
        case "paint.point":
          if (
            participantsRef.current.some((participant) => participant.clientId === message.clientId)
          ) {
            paintSubject.next({ type: "point", message });
          }
          return;
        case "recordings.state":
          setRecordings(message.recordings);
          return;
        case "presentation.state":
          setPresentation(message.presentation);
          return;
        case "error":
          claimPendingRef.current = false;
          releasePendingRef.current = false;
          setLastError({ code: message.code, message: message.message });
          return;
        default:
          if (message.presentation) {
            setPresentation(message.presentation);
          }
          if (!message.ok) {
            setLastError({
              code: message.code ?? "request_rejected",
              message: message.message ?? "Live session command failed.",
            });
          }
      }
    },
    [paintSubject],
  );

  useEffect(() => {
    if (!enabled || !sessionId || !credentials) {
      connectionRef.current?.close();
      connectionRef.current = null;
      setPhase("idle");
      setTargets([]);
      setActiveTargetId(null);
      setMediaStream(null);
      setMediaSize(null);
      setTransport(null);
      setPresentation(null);
      setTargetSwitching(false);
      setPresentationSwitching(false);
      setParticipants([]);
      setCursors(new Map());
      setRecordings([]);
      frameSubject.next(null);
      paintSubject.next({ type: "clear" });
      return;
    }

    const connection = new LiveSessionConnection({
      sessionId,
      role,
      credentials,
      sessionToken,
      identity,
      iceServers,
      webrtcSupported,
      callbacks: {
        onPhase: setPhase,
        onMessage: handleMessage,
        onFrame: (frame) => frameSubject.next(frame),
        onStream: setMediaStream,
        onTransport: setTransport,
        onError: (message) => setLastError({ code: "connection_failed", message }),
      },
    });
    connectionRef.current = connection;
    connection.connect();
    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
      connection.close();
      frameSubject.next(null);
      paintSubject.next({ type: "clear" });
    };
  }, [
    credentials,
    enabled,
    frameSubject,
    handleMessage,
    iceServers,
    identity,
    paintSubject,
    role,
    sessionId,
    sessionToken,
    webrtcSupported,
  ]);

  const sendReliable = useCallback(
    (message: Record<string, unknown>) => connectionRef.current?.sendReliable(message) ?? false,
    [],
  );
  const sendRealtime = useCallback(
    (message: Record<string, unknown>) => connectionRef.current?.sendRealtime(message) ?? false,
    [],
  );
  const command = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const connection = connectionRef.current;
    if (!connection) {
      return false;
    }
    void connection.command(type, payload).catch((cause: unknown) => {
      setTargetSwitching(false);
      setLastError({
        code: "request_rejected",
        message: cause instanceof Error ? cause.message : "Live session command failed.",
      });
    });
    return true;
  }, []);
  const request = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const connection = connectionRef.current;
    return connection
      ? connection.command(type, payload)
      : Promise.reject(new Error("live session transport is unavailable"));
  }, []);
  const selectTarget = useCallback((targetId: string) => {
    const connection = connectionRef.current;
    if (!connection) {
      return false;
    }
    setTargetSwitching(true);
    void connection
      .command("target.select", { targetId })
      .then(() => setActiveTargetId(targetId))
      .catch((cause: unknown) => {
        setLastError({
          code: "request_rejected",
          message: cause instanceof Error ? cause.message : "Target selection failed.",
        });
      })
      .finally(() => setTargetSwitching(false));
    return true;
  }, []);

  const selectPresentation = useCallback((selection: LiveSessionMediaSelection) => {
    const connection = connectionRef.current;
    if (!connection) {
      return Promise.reject(new Error("live session transport is unavailable"));
    }
    if (presentationSelectionRef.current) {
      return Promise.reject(new Error("another presentation update is already in progress"));
    }
    setPresentationSwitching(true);
    const operation = (async () => {
      let restoreWebRTC = false;
      try {
        switch (selection.kind) {
          case "jpeg":
            await connection.selectTransport("websocket");
            return;
          case "webrtc-retry":
            await connection.selectTransport("webrtc");
            return;
          case "webrtc": {
            const size = mediaSizeRef.current;
            if (!size) {
              throw new Error("presentation size is unavailable");
            }
            const profileChanged =
              presentationRef.current?.quality?.profile !== selection.quality.profile;
            if (profileChanged && transportRef.current === "webrtc") {
              await connection.selectTransport("websocket");
              restoreWebRTC = true;
            }
            const result = await connection.command("presentation.quality.set", {
              profile: selection.quality.profile,
              width: size.canvasWidth,
              height: size.canvasHeight,
              fps: selection.quality.fps,
              bitrateKbps: selection.quality.bitrateKbps,
            });
            restoreWebRTC = false;
            if (result.presentation) {
              setPresentation(result.presentation);
            }
            await connection.selectTransport("webrtc");
            return;
          }
          default: {
            const exhaustive: never = selection;
            return exhaustive;
          }
        }
      } catch (cause) {
        if (restoreWebRTC) {
          try {
            await connection.selectTransport("webrtc");
          } catch {
            // Keep the quality update error as the reported failure.
          }
        }
        const message = cause instanceof Error ? cause.message : "Presentation update failed.";
        setLastError({ code: "presentation_update_failed", message });
        throw cause;
      }
    })();
    presentationSelectionRef.current = operation;
    return operation.finally(() => {
      if (presentationSelectionRef.current === operation) {
        presentationSelectionRef.current = null;
        setPresentationSwitching(false);
      }
    });
  }, []);

  const claim = useCallback(
    (targetId: string, mode: CollaborationLeaseMode) => {
      if (role === "viewer" || !sendReliable({ type: "input.claim", targetId, mode })) {
        return false;
      }
      claimPendingRef.current = true;
      releasePendingRef.current = false;
      return true;
    },
    [role, sendReliable],
  );
  const release = useCallback(() => {
    if (
      releasePendingRef.current ||
      holderClientIdRef.current !== clientIdRef.current ||
      !sendReliable({ type: "input.release" })
    ) {
      return false;
    }
    releasePendingRef.current = true;
    claimPendingRef.current = false;
    return true;
  }, [sendReliable]);
  const setActiveTarget = useCallback(
    (targetId: string | null) => (targetId ? selectTarget(targetId) : false),
    [selectTarget],
  );
  const follow = useCallback(
    (followingClientId: string | null) =>
      sendReliable({ type: "follow.set", followingClientId: followingClientId ?? "" }),
    [sendReliable],
  );
  const sendCursor = useCallback(
    (targetId: string, x: number, y: number, dimensions: InputDimensions) => {
      const now = performance.now();
      if (now - lastCursorSentAtRef.current < cursorIntervalMs) {
        return false;
      }
      lastCursorSentAtRef.current = now;
      const sent = sendRealtime({
        type: "presence.cursor",
        targetId,
        x: normalizedCoordinate(x, dimensions.width),
        y: normalizedCoordinate(y, dimensions.height),
      });
      if (sent) {
        cursorVisibleRef.current = true;
      }
      return sent;
    },
    [sendRealtime],
  );
  const sendPaintPoint = useCallback(
    (point: CollaborationPaintPoint) =>
      point.phase === "move"
        ? sendRealtime({ type: "paint.point", ...point })
        : sendReliable({ type: "paint.point", ...point }),
    [sendRealtime, sendReliable],
  );
  const clearCursor = useCallback(() => {
    if (!cursorVisibleRef.current || !sendReliable({ type: "presence.cursor.clear" })) {
      return false;
    }
    cursorVisibleRef.current = false;
    return true;
  }, [sendReliable]);

  const sendInputEvent = useCallback(
    (message: Record<string, unknown>, realtime = false) =>
      realtime ? sendRealtime(message) : sendReliable(message),
    [sendRealtime, sendReliable],
  );
  const sendBrowserInput = useCallback(
    (message: BrowserInputMessage, dimensions: InputDimensions) => {
      if (
        role === "viewer" ||
        (holderClientIdRef.current !== clientIdRef.current && !claimPendingRef.current)
      ) {
        return false;
      }
      switch (message.type) {
        case "input.mouse": {
          const x = normalizedCoordinate(message.x, dimensions.width);
          const y = normalizedCoordinate(message.y, dimensions.height);
          if (message.action === "move") {
            return sendInputEvent(
              {
                type: "input.pointer.motion.absolute",
                targetId: message.targetId,
                x,
                y,
                width: dimensions.width,
                height: dimensions.height,
                modifiers: message.modifiers ?? 0,
              },
              true,
            );
          }
          if (message.button === "none") {
            return true;
          }
          const buttonCode = pointerButtonCode[message.button ?? "left"];
          const sendButton = (pressed: boolean, clickCount: number) =>
            sendInputEvent({
              type: "input.pointer.button",
              targetId: message.targetId,
              x,
              y,
              width: dimensions.width,
              height: dimensions.height,
              buttonCode,
              pressed,
              clickCount,
              modifiers: message.modifiers ?? 0,
            });
          if (message.action === "down" || message.action === "up") {
            return sendButton(message.action === "down", message.clickCount ?? 1);
          }
          const count = message.action === "doubleClick" ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            const clickCount = message.action === "doubleClick" ? index + 1 : 1;
            sendButton(true, clickCount);
            sendButton(false, clickCount);
          }
          return true;
        }
        case "input.wheel": {
          const x = normalizedCoordinate(message.x, dimensions.width);
          const y = normalizedCoordinate(message.y, dimensions.height);
          sendInputEvent({
            type: "input.pointer.scroll",
            targetId: message.targetId,
            x,
            y,
            width: dimensions.width,
            height: dimensions.height,
            horizontal: message.deltaX,
            vertical: message.deltaY,
            stopHorizontal: false,
            stopVertical: false,
            modifiers: message.modifiers ?? 0,
          });
          return sendInputEvent({
            type: "input.pointer.scroll",
            targetId: message.targetId,
            x,
            y,
            width: dimensions.width,
            height: dimensions.height,
            horizontal: 0,
            vertical: 0,
            stopHorizontal: message.deltaX !== 0,
            stopVertical: message.deltaY !== 0,
            modifiers: message.modifiers ?? 0,
          });
        }
        case "input.key": {
          if (message.action === "char") {
            return message.text
              ? sendInputEvent({
                  type: "input.keyboard.text",
                  targetId: message.targetId,
                  text: message.text,
                })
              : false;
          }
          const keycode = evdevKeycodeByCode[message.code ?? ""];
          if (!keycode) {
            return false;
          }
          const windowsVirtualKeyCode =
            message.windowsVirtualKeyCode ??
            windowsVirtualKeyCodeForCodeOrKey(message.code, message.key);
          return sendInputEvent({
            type: "input.keyboard.key",
            targetId: message.targetId,
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
          });
        }
        case "clipboard.copy":
          return sendShortcut(sendInputEvent, message.targetId, "KeyC");
        case "clipboard.cut":
          return sendShortcut(sendInputEvent, message.targetId, "KeyX");
        case "clipboard.paste": {
          const item = message.items.find((candidate) => candidate.mimeType === "text/plain");
          return item
            ? sendInputEvent({
                type: "input.keyboard.text",
                targetId: message.targetId,
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
    [role, sendInputEvent],
  );

  const hasControl = holderClientId === clientId && clientId !== "";
  const followingClientId =
    participants.find((participant) => participant.clientId === clientId)?.followingClientId ??
    null;
  useEffect(() => {
    if (!hasControl) {
      return;
    }
    const timer = window.setInterval(() => {
      if (holderClientIdRef.current === clientIdRef.current) {
        sendReliable({ type: "input.heartbeat" });
      }
    }, heartbeatIntervalMs);
    return () => window.clearInterval(timer);
  }, [hasControl, sendReliable]);

  return {
    phase,
    targets,
    activeTargetId,
    frame$: frameSubject,
    mediaStream,
    mediaSize,
    transport,
    presentation,
    mediaSwitching: targetSwitching || presentationSwitching,
    recordings,
    sendBrowserInput,
    selectTarget,
    command,
    request,
    selectPresentation,
    reconnect: () => connectionRef.current?.reconnect(),
    collaboration: {
      phase: phase === "error" ? "disconnected" : phase,
      role,
      clientId,
      holderClientId,
      leaseMode,
      hasControl,
      canRequestControl: role !== "viewer" && phase === "connected",
      lastError,
      participants,
      cursors,
      paintEvents: paintSubject,
      followingClientId,
      claim,
      release,
      setActiveTarget,
      follow,
      sendCursor,
      sendPaintPoint,
      clearCursor,
      sendInput: sendBrowserInput,
    },
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
      const value: unknown = JSON.parse(stored);
      const parsed = storedIdentitySchema.safeParse(value);
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
  const adjective = adjectives[(random.at(0) ?? 0) % adjectives.length] ?? "Quiet";
  const animal = animals[(random.at(1) ?? 0) % animals.length] ?? "Otter";
  return {
    name: `${adjective} ${animal}`,
    avatarHash: Array.from(random.slice(2), (value) => value.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}

function resolveMediaSize(
  targets: Array<{
    id: string;
    viewport?: {
      width: number;
      height: number;
      canvasWidth: number;
      canvasHeight: number;
      deviceScaleFactor: number;
    };
  }>,
  activeTargetId: string | undefined,
): LiveSessionMediaSize | null {
  const viewport = targets.find((target) => target.id === activeTargetId)?.viewport;
  return viewport
    ? {
        width: viewport.width,
        height: viewport.height,
        canvasWidth: viewport.canvasWidth,
        canvasHeight: viewport.canvasHeight,
        deviceScaleFactor: viewport.deviceScaleFactor,
      }
    : null;
}

function normalizedCoordinate(value: number, length: number) {
  if (length <= 1) {
    return 0;
  }
  return Math.min(1, Math.max(0, value / length));
}

function sendShortcut(
  sendInputEvent: (message: Record<string, unknown>, realtime?: boolean) => boolean,
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
  sendInputEvent({
    type: "input.keyboard.key",
    targetId,
    keycode: controlKeycode,
    pressed: true,
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: controlVirtualKeyCode,
    nativeVirtualKeyCode: controlVirtualKeyCode,
    modifiers: 2,
  });
  sendInputEvent({
    type: "input.keyboard.key",
    targetId,
    keycode: shortcutKeycode,
    pressed: true,
    key: shortcutKey,
    code,
    windowsVirtualKeyCode: shortcutVirtualKeyCode,
    nativeVirtualKeyCode: shortcutVirtualKeyCode,
    modifiers: 2,
  });
  sendInputEvent({
    type: "input.keyboard.key",
    targetId,
    keycode: shortcutKeycode,
    pressed: false,
    key: shortcutKey,
    code,
    windowsVirtualKeyCode: shortcutVirtualKeyCode,
    nativeVirtualKeyCode: shortcutVirtualKeyCode,
    modifiers: 2,
  });
  return sendInputEvent({
    type: "input.keyboard.key",
    targetId,
    keycode: controlKeycode,
    pressed: false,
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: controlVirtualKeyCode,
    nativeVirtualKeyCode: controlVirtualKeyCode,
    modifiers: 0,
  });
}

export type {
  CollaborationCursor,
  CollaborationError,
  CollaborationLeaseMode,
  CollaborationPaintEvent,
  CollaborationPaintPoint,
  CollaborationParticipant,
  CollaborationPhase,
  CollaborationRole,
};
