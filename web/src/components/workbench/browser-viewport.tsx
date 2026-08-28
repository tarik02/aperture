import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, MousePointer2, Unplug } from "lucide-react";
import { interval } from "rxjs";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge.tsx";
import {
  keyboardInputMessage,
  keyboardModifiers,
  shouldForwardBrowserShortcut,
} from "#/lib/control/keyboard.ts";
import { computeRenderMetrics } from "#/lib/control/viewport.ts";
import type { LiveSessionRasterFrame } from "#/lib/control/live-session-protocol.ts";
import type { ViewportPreset } from "#/lib/control/viewport.ts";
import { cn } from "#/lib/utils.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { CollaborationPaintOverlay } from "#/components/workbench/collaboration-paint-overlay.tsx";

type BrowserViewportProps = {
  control: UseBrowserControlResult;
  viewport: ViewportPreset;
  localCursorEnabled: boolean;
  paintingEnabled: boolean;
  onPaintingEnabledChange: (enabled: boolean) => void;
};

type MouseButton = "left" | "middle" | "right" | "none";
type ViewportPoint = { x: number; y: number };
type FrameMetadata = Pick<LiveSessionRasterFrame, "width" | "height">;
type PressedKey = {
  targetId: string;
  input: ReturnType<typeof keyboardInputMessage>;
};

const MULTI_CLICK_MS = 500;
const MULTI_CLICK_DISTANCE = 5;

export function BrowserViewport({
  control,
  viewport,
  localCursorEnabled,
  paintingEnabled,
  onPaintingEnabledChange,
}: BrowserViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<LiveSessionRasterFrame | null>(null);
  const frameMetadataRef = useRef<FrameMetadata | null>(null);
  const frameStaleRef = useRef(false);
  const pressedKeysRef = useRef(new Map<string, PressedKey>());
  const releasedKeysRef = useRef(new Set<string>());
  const pointerCaptureRef = useRef<{
    pointerId: number;
    targetId: string;
    button: MouseButton;
    clickCount: number;
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const implicitControlDesiredRef = useRef(false);
  const cursorHintPointRef = useRef<ViewportPoint | null>(null);
  const lastClickRef = useRef<{
    targetId: string;
    button: MouseButton;
    point: ViewportPoint;
    time: number;
    clickCount: number;
  } | null>(null);
  const [cursorHintPoint, setCursorHintPoint] = useState<ViewportPoint | null>(null);
  const [frameMetadata, setFrameMetadata] = useState<FrameMetadata | null>(null);
  const [frameStale, setFrameStale] = useState(false);
  const [presentedMedia, setPresentedMedia] = useState<{
    stream: MediaStream;
    targetId: string;
    size: NonNullable<UseBrowserControlResult["mediaSize"]>;
  } | null>(null);

  const showingWebRTC =
    control.mediaPath === "webrtc-live" &&
    control.mediaPhase === "live" &&
    Boolean(control.mediaStream) &&
    Boolean(control.activeTargetId);
  const mediaTransitioning =
    showingWebRTC &&
    (control.mediaSwitching ||
      control.mediaTargetId !== control.activeTargetId ||
      presentedMedia?.stream !== control.mediaStream ||
      presentedMedia?.targetId !== control.activeTargetId);
  const paintOverlayEnabled =
    paintingEnabled &&
    (showingWebRTC || frameMetadata !== null) &&
    control.collaboration.phase === "connected" &&
    !control.mediaSwitching &&
    !mediaTransitioning;
  const inputDisabled =
    paintingEnabled ||
    control.mediaSwitching ||
    mediaTransitioning ||
    control.collaboration.phase !== "connected" ||
    control.collaboration.role === "viewer";
  const displayedMediaSize =
    mediaTransitioning && presentedMedia ? presentedMedia.size : control.mediaSize;
  const renderWidth = showingWebRTC
    ? (displayedMediaSize?.width ?? viewport.width)
    : (frameMetadata?.width ?? viewport.width);
  const renderHeight = showingWebRTC
    ? (displayedMediaSize?.height ?? viewport.height)
    : (frameMetadata?.height ?? viewport.height);
  const inputWidth = showingWebRTC ? renderWidth : viewport.width;
  const inputHeight = showingWebRTC ? renderHeight : viewport.height;
  const contentWidth = showingWebRTC
    ? Math.min(
        displayedMediaSize?.canvasWidth ?? renderWidth,
        Math.round(renderWidth * (displayedMediaSize?.deviceScaleFactor ?? 1)),
      )
    : renderWidth;
  const contentHeight = showingWebRTC
    ? Math.min(
        displayedMediaSize?.canvasHeight ?? renderHeight,
        Math.round(renderHeight * (displayedMediaSize?.deviceScaleFactor ?? 1)),
      )
    : renderHeight;
  const displayMetrics = computeRenderMetrics(
    control.browserViewportSize?.width ?? renderWidth,
    control.browserViewportSize?.height ?? renderHeight,
    renderWidth,
    renderHeight,
  );
  const disconnectedHint = resolveDisconnectedHint(control.phase);
  const collaborationHint = resolveCollaborationHint(control.collaboration);
  const cursorHint = disconnectedHint ?? collaborationHint;
  const displayedCursorHintPoint = cursorHint
    ? (cursorHintPointRef.current ?? cursorHintPoint)
    : null;
  const followedParticipant = control.collaboration.followingClientId
    ? control.collaboration.participants.find(
        (participant) => participant.clientId === control.collaboration.followingClientId,
      )
    : null;
  const followedCursor = followedParticipant
    ? control.collaboration.cursors.get(followedParticipant.clientId)
    : null;
  const followedCursorPoint =
    followedCursor?.targetId === control.activeTargetId
      ? {
          x: displayMetrics.offsetX + followedCursor.x * displayMetrics.renderedWidth,
          y: displayMetrics.offsetY + followedCursor.y * displayMetrics.renderedHeight,
        }
      : null;

  useEffect(() => {
    control.setInputDimensions({ width: inputWidth, height: inputHeight });
  }, [control.setInputDimensions, inputHeight, inputWidth]);

  const releasePressedKeys = useCallback(() => {
    const pressedKeys = [...pressedKeysRef.current.entries()].reverse();
    pressedKeysRef.current.clear();

    for (const [keyId, pressedKey] of pressedKeys) {
      const sent = control.sendInput({
        type: "input.key",
        targetId: pressedKey.targetId,
        action: "up",
        ...pressedKey.input,
        text: undefined,
        modifiers: 0,
        autoRepeat: false,
      });
      if (sent) {
        releasedKeysRef.current.add(keyId);
      }
    }
  }, [control.sendInput]);

  useEffect(() => {
    const subscription = control.frame$.subscribe((frame) => {
      frameRef.current = frame;
      if (!frame) {
        if (imageRef.current) {
          clearImageSource(imageRef.current);
        }
        if (frameMetadataRef.current !== null) {
          frameMetadataRef.current = null;
          setFrameMetadata(null);
        }
        if (frameStaleRef.current) {
          frameStaleRef.current = false;
          setFrameStale(false);
        }
        return;
      }

      if (imageRef.current && !showingWebRTC) {
        setImageFrame(imageRef.current, frame);
      }
      const currentMetadata = frameMetadataRef.current;
      if (currentMetadata?.width !== frame.width || currentMetadata?.height !== frame.height) {
        const nextMetadata = { width: frame.width, height: frame.height };
        frameMetadataRef.current = nextMetadata;
        setFrameMetadata(nextMetadata);
      }
      if (frameStaleRef.current) {
        frameStaleRef.current = false;
        setFrameStale(false);
      }
    });

    return () => {
      subscription.unsubscribe();
      if (imageRef.current) {
        clearImageSource(imageRef.current);
      }
    };
  }, [control.frame$, showingWebRTC]);

  useEffect(() => {
    const subscription = interval(500).subscribe(() => {
      const frame = frameRef.current;
      const nextStale = frame !== null && Date.now() - frame.receivedAt > 3000;
      if (nextStale === frameStaleRef.current) {
        return;
      }
      frameStaleRef.current = nextStale;
      setFrameStale(nextStale);
    });

    return () => subscription.unsubscribe();
  }, [control.frame$]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.srcObject = showingWebRTC ? control.mediaStream : null;
  }, [control.mediaStream, showingWebRTC]);

  useEffect(() => {
    const video = videoRef.current;
    const stream = control.mediaStream;
    const targetId = control.activeTargetId;
    const size = control.mediaSize;
    if (
      !showingWebRTC ||
      !video ||
      !stream ||
      !targetId ||
      !size ||
      control.mediaSwitching ||
      control.mediaTargetId !== targetId ||
      (presentedMedia?.stream === stream && presentedMedia.targetId === targetId)
    ) {
      return;
    }
    const callback = video.requestVideoFrameCallback(() => {
      setPresentedMedia({ stream, targetId, size });
    });
    return () => video.cancelVideoFrameCallback(callback);
  }, [
    control.activeTargetId,
    control.mediaSize,
    control.mediaStream,
    control.mediaSwitching,
    control.mediaTargetId,
    presentedMedia,
    showingWebRTC,
  ]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const syncSize = (width: number, height: number) => {
      control.setBrowserViewportSize({ width, height });
    };

    const rect = element.getBoundingClientRect();
    syncSize(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        syncSize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [control.setBrowserViewportSize]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      releasePressedKeys();
    };
  }, [releasePressedKeys]);

  useEffect(() => {
    const handleWindowBlur = () => {
      releasePressedKeys();
      releaseImplicitControl();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        releasePressedKeys();
        releaseImplicitControl();
      }
    };

    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [releasePressedKeys, control.collaboration]);

  useEffect(() => {
    if (inputDisabled) {
      dragCleanupRef.current?.();
      releasePressedKeys();
      releaseImplicitControl();
    }
  }, [inputDisabled, releasePressedKeys]);

  useEffect(() => {
    if (paintingEnabled) {
      control.setCaptured(false);
      implicitControlDesiredRef.current = false;
    }
    if (
      control.collaboration.hasControl &&
      control.collaboration.leaseMode === "implicit" &&
      !implicitControlDesiredRef.current
    ) {
      control.collaboration.release();
    }
  }, [
    control.collaboration.hasControl,
    control.collaboration.leaseMode,
    control.collaboration.release,
    control.setCaptured,
    paintingEnabled,
  ]);

  function mapPointer(event: { clientX: number; clientY: number }, clamp: boolean) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    const metrics = computeRenderMetrics(rect.width, rect.height, renderWidth, renderHeight);
    const localX = event.clientX - rect.left - metrics.offsetX;
    const localY = event.clientY - rect.top - metrics.offsetY;
    if (
      !clamp &&
      (localX < 0 ||
        localY < 0 ||
        localX > metrics.renderedWidth ||
        localY > metrics.renderedHeight)
    ) {
      return null;
    }
    const x = (localX / metrics.scale) * (inputWidth / renderWidth);
    const y = (localY / metrics.scale) * (inputHeight / renderHeight);
    if (clamp) {
      return {
        x: Math.round(clampNumber(x, 0, Math.max(inputWidth - 1, 0))),
        y: Math.round(clampNumber(y, 0, Math.max(inputHeight - 1, 0))),
      };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function resolveInputTarget() {
    if (control.phase !== "connected" || !control.activeTargetId || inputDisabled) {
      return null;
    }
    if (!control.captured) {
      control.setCaptured(true);
    }
    requestImplicitControl(control.activeTargetId);
    containerRef.current?.focus();
    return control.activeTargetId;
  }

  function requestImplicitControl(targetId: string) {
    implicitControlDesiredRef.current = true;
    if (!control.collaboration.hasControl) {
      control.collaboration.claim(targetId, "implicit");
    }
  }

  function releaseImplicitControl() {
    implicitControlDesiredRef.current = false;
    if (control.collaboration.hasControl && control.collaboration.leaseMode === "implicit") {
      control.collaboration.release();
    }
  }

  function preventViewportDefault(event: React.SyntheticEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  function preventNativeDefault(event: PointerEvent) {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  function handleCaptureClick() {
    if (control.phase !== "connected" || inputDisabled) {
      return;
    }
    control.setCaptured(true);
    if (control.activeTargetId) {
      requestImplicitControl(control.activeTargetId);
    }
    containerRef.current?.focus();
  }

  function handlePointerEnter(event: React.PointerEvent) {
    updateCursorHint(event);
    if (inputDisabled || !control.activeTargetId) {
      return;
    }
    control.setCaptured(true);
    requestImplicitControl(control.activeTargetId);
  }

  function handlePointerLeave() {
    cursorHintPointRef.current = null;
    setCursorHintPoint(null);
    control.collaboration.clearCursor();
    if (!pointerCaptureRef.current) {
      releasePressedKeys();
      releaseImplicitControl();
      control.setCaptured(false);
    }
  }

  function handlePointerClick() {
    if (!control.captured) {
      handleCaptureClick();
    }
  }

  function handlePointerMove(event: React.PointerEvent) {
    updateCursorHint(event);

    const point = mapPointer(event, false);
    if (control.activeTargetId && point) {
      control.collaboration.sendCursor(control.activeTargetId, point.x, point.y, {
        width: inputWidth,
        height: inputHeight,
      });
    } else if (!point) {
      control.collaboration.clearCursor();
    }

    if (inputDisabled) {
      return;
    }

    const capturedPointer = pointerCaptureRef.current;
    if (capturedPointer?.pointerId === event.pointerId) {
      return;
    }
    const targetId = control.captured && event.buttons === 0 ? control.activeTargetId : null;
    if (!targetId) {
      return;
    }
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    control.sendInput({
      type: "input.mouse",
      targetId,
      action: "move",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function handlePointerDown(event: React.PointerEvent) {
    updateCursorHint(event);

    const targetId = resolveInputTarget();
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, false);
    if (!point) {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const button = resolveMouseButton(event.button);
    const now = Date.now();
    const clickCount = resolveClickCount(targetId, button, point, now, lastClickRef.current);
    lastClickRef.current = {
      targetId,
      button,
      point,
      time: now,
      clickCount,
    };
    preventViewportDefault(event);
    pointerCaptureRef.current = { pointerId: event.pointerId, targetId, button, clickCount };
    dragCleanupRef.current?.();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and some browser edge cases do not create a capturable pointer.
    }
    bindDragListeners({
      pointerId: event.pointerId,
      targetId,
      button,
      clickCount,
      element,
    });
    control.sendInput({
      type: "input.mouse",
      targetId,
      action: "down",
      x: point.x,
      y: point.y,
      button,
      buttons: event.buttons,
      clickCount,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function handlePointerUp(event: React.PointerEvent) {
    if (inputDisabled) {
      return;
    }
    const capturedPointer = pointerCaptureRef.current;
    const targetId =
      capturedPointer?.pointerId === event.pointerId
        ? capturedPointer.targetId
        : control.activeTargetId;
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, capturedPointer?.pointerId === event.pointerId);
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    control.sendInput({
      type: "input.mouse",
      targetId,
      action: "up",
      x: point.x,
      y: point.y,
      button: capturedPointer?.button ?? resolveMouseButton(event.button),
      buttons: event.buttons,
      clickCount: capturedPointer?.clickCount ?? 1,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
    if (capturedPointer?.pointerId === event.pointerId) {
      pointerCaptureRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  function handlePointerCancel(event: React.PointerEvent) {
    const capturedPointer = pointerCaptureRef.current;
    if (capturedPointer?.pointerId !== event.pointerId) {
      return;
    }
    const point = mapPointer(event, true);
    pointerCaptureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!point || inputDisabled) {
      return;
    }
    preventViewportDefault(event);
    control.sendInput({
      type: "input.mouse",
      targetId: capturedPointer.targetId,
      action: "up",
      x: point.x,
      y: point.y,
      button: capturedPointer.button,
      buttons: 0,
      clickCount: capturedPointer.clickCount,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function bindDragListeners({
    pointerId,
    targetId,
    button,
    clickCount,
    element,
  }: {
    pointerId: number;
    targetId: string;
    button: MouseButton;
    clickCount: number;
    element: HTMLDivElement;
  }) {
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      const point = mapPointer(event, true);
      preventNativeDefault(event);
      if (!point) {
        return;
      }
      control.collaboration.sendCursor(targetId, point.x, point.y, {
        width: inputWidth,
        height: inputHeight,
      });
      control.sendInput({
        type: "input.mouse",
        targetId,
        action: "move",
        x: point.x,
        y: point.y,
        button,
        buttons: event.buttons || mouseButtonsForButton(button),
        clickCount,
        modifiers: keyboardModifiers(event),
      });
    };

    const finish = (event: PointerEvent, canceled: boolean) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      const point = mapPointer(event, true);
      if (!mapPointer(event, false)) {
        control.collaboration.clearCursor();
      }
      preventNativeDefault(event);
      if (point) {
        control.sendInput({
          type: "input.mouse",
          targetId,
          action: "up",
          x: point.x,
          y: point.y,
          button,
          buttons: 0,
          clickCount,
          modifiers: keyboardModifiers(event),
        });
        if (!canceled) {
          lastClickRef.current = {
            targetId,
            button,
            point,
            time: Date.now(),
            clickCount,
          };
        }
      }
      cleanup();
    };

    const handleUp = (event: PointerEvent) => finish(event, false);
    const handleCancel = (event: PointerEvent) => finish(event, true);
    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerup", handleUp, true);
      window.removeEventListener("pointercancel", handleCancel, true);
      try {
        if (element.hasPointerCapture(pointerId)) {
          element.releasePointerCapture(pointerId);
        }
      } catch {
        // Synthetic pointer events and released native pointers may not have active capture.
      }
      if (pointerCaptureRef.current?.pointerId === pointerId) {
        pointerCaptureRef.current = null;
      }
      if (dragCleanupRef.current === cleanup) {
        dragCleanupRef.current = null;
      }
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove, true);
    window.addEventListener("pointerup", handleUp, true);
    window.addEventListener("pointercancel", handleCancel, true);
  }

  function handleWheel(event: React.WheelEvent) {
    const targetId = resolveInputTarget();
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, false);
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    const wheelScale = wheelDeltaScale(event.deltaMode, inputHeight);
    control.sendInput({
      type: "input.wheel",
      targetId,
      x: point.x,
      y: point.y,
      deltaX: event.deltaX * wheelScale,
      deltaY: event.deltaY * wheelScale,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && paintingEnabled) {
      event.preventDefault();
      event.stopPropagation();
      onPaintingEnabledChange(false);
      return;
    }
    if (event.key === "Escape") {
      if (control.captured) {
        event.preventDefault();
        event.stopPropagation();
        control.setCaptured(false);
        releaseImplicitControl();
      }
      return;
    }
    const keyId = event.code || event.key;
    if (event.repeat && releasedKeysRef.current.has(keyId)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const targetId = control.activeTargetId;
    if (
      inputDisabled ||
      !targetId ||
      (!control.captured &&
        document.activeElement !== containerRef.current &&
        !containerRef.current?.contains(event.target as Node))
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const clipboardShortcut = resolveClipboardShortcut(event.nativeEvent);
    if (clipboardShortcut === "copy") {
      control.sendInput({ type: "clipboard.copy", targetId });
      return;
    }
    if (clipboardShortcut === "cut") {
      control.sendInput({ type: "clipboard.cut", targetId });
      return;
    }
    if (clipboardShortcut === "paste") {
      void pasteClipboard(control);
      return;
    }

    if (!shouldForwardBrowserShortcut(event.nativeEvent)) {
      return;
    }

    const input = keyboardInputMessage(event.nativeEvent, "down");
    const sent = control.sendInput({
      type: "input.key",
      targetId,
      action: "down",
      ...input,
    });
    if (sent) {
      releasedKeysRef.current.delete(keyId);
      pressedKeysRef.current.set(keyId, { targetId, input });
    }
  }

  function handleKeyUp(event: React.KeyboardEvent) {
    const keyId = event.code || event.key;
    if (releasedKeysRef.current.delete(keyId)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const pressedKey = pressedKeysRef.current.get(keyId);
    const targetId = pressedKey?.targetId ?? control.activeTargetId;
    const canForwardUntrackedKey =
      !inputDisabled &&
      (control.captured ||
        document.activeElement === containerRef.current ||
        Boolean(containerRef.current?.contains(event.target as Node)));
    if (!targetId || (!pressedKey && !canForwardUntrackedKey)) {
      return;
    }
    if (event.key === "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!pressedKey && resolveClipboardShortcut(event.nativeEvent)) {
      return;
    }

    if (!pressedKey && !shouldForwardBrowserShortcut(event.nativeEvent)) {
      return;
    }

    const sent = control.sendInput({
      type: "input.key",
      targetId,
      action: "up",
      ...keyboardInputMessage(event.nativeEvent, "up"),
    });
    if (sent) {
      pressedKeysRef.current.delete(keyId);
    }
  }

  function handleBlur(event: React.FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    releasePressedKeys();
    releaseImplicitControl();
    control.setCaptured(false);
  }

  function updateCursorHint(event: React.PointerEvent) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    cursorHintPointRef.current = point;
    if (cursorHint) {
      setCursorHintPoint(point);
    }
  }

  const status = resolveViewportStatus(
    control.phase,
    frameMetadata !== null,
    frameStale,
    control.mediaPhase,
    control.mediaPath,
    showingWebRTC,
  );
  const visibleCollaborationError =
    collaborationHint || isInputOwnershipError(control.collaboration.lastError)
      ? null
      : control.collaboration.lastError;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onClick={handlePointerClick}
      onPointerMove={handlePointerMove}
      onFocus={() => {
        if (!inputDisabled && control.activeTargetId) {
          requestImplicitControl(control.activeTargetId);
        }
      }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      onContextMenu={(event) => {
        if (control.captured) {
          event.preventDefault();
        }
      }}
      aria-busy={mediaTransitioning}
      aria-disabled={inputDisabled}
      className={cn(
        "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-background outline-none",
        !localCursorEnabled && "cursor-none",
      )}
    >
      {showingWebRTC ? (
        <div
          className={cn(
            "relative overflow-hidden bg-black transition-opacity duration-150",
            mediaTransitioning && "opacity-75",
          )}
          style={{
            width: displayMetrics.renderedWidth,
            height: displayMetrics.renderedHeight,
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            data-viewport-width={renderWidth}
            data-viewport-height={renderHeight}
            className="absolute top-0 left-0 max-w-none object-fill"
            style={{
              width:
                displayMetrics.renderedWidth *
                ((displayedMediaSize?.canvasWidth ?? contentWidth) / contentWidth),
              height:
                displayMetrics.renderedHeight *
                ((displayedMediaSize?.canvasHeight ?? contentHeight) / contentHeight),
            }}
          />
        </div>
      ) : frameMetadata ? (
        <div
          className="relative overflow-hidden bg-black"
          style={{
            width: displayMetrics.renderedWidth,
            height: displayMetrics.renderedHeight,
          }}
        >
          <img
            ref={imageRef}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
      ) : (
        <ViewportPlaceholder
          phase={control.phase}
          mediaPhase={control.mediaPhase}
          switching={control.mediaSwitching}
        />
      )}
      <div className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1.5">
        <StatusBadge status={status} />
      </div>
      {control.activeTargetId ? (
        <CollaborationPaintOverlay
          collaboration={control.collaboration}
          targetId={control.activeTargetId}
          enabled={paintOverlayEnabled}
          visible={
            !control.mediaSwitching &&
            !mediaTransitioning &&
            (showingWebRTC || frameMetadata !== null)
          }
          left={displayMetrics.offsetX}
          top={displayMetrics.offsetY}
          width={displayMetrics.renderedWidth}
          height={displayMetrics.renderedHeight}
        />
      ) : null}
      {followedCursorPoint && followedParticipant ? (
        <div
          className="pointer-events-none absolute z-30 flex translate-x-[-2px] translate-y-[-2px] items-start text-primary drop-shadow-sm"
          style={{ left: followedCursorPoint.x, top: followedCursorPoint.y }}
        >
          <MousePointer2 className="size-5 fill-primary stroke-background stroke-[1.5]" />
          <span className="mt-4 -ml-1 rounded bg-primary px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap text-primary-foreground">
            {followedParticipant.name}
          </span>
        </div>
      ) : null}
      {cursorHint && displayedCursorHintPoint ? (
        <div
          className="pointer-events-none absolute z-20 max-w-64 translate-x-3 translate-y-3 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: displayedCursorHintPoint.x, top: displayedCursorHintPoint.y }}
        >
          {cursorHint}
        </div>
      ) : null}
      {visibleCollaborationError ? (
        <div className="pointer-events-none absolute bottom-10 left-2 max-w-[80%] rounded-md border border-amber-500/40 bg-background/90 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
          {visibleCollaborationError.message}
        </div>
      ) : null}
    </div>
  );
}

function resolveDisconnectedHint(phase: UseBrowserControlResult["phase"]): string | null {
  if (phase === "disconnected" || phase === "error") {
    return "Session disconnected";
  }
  return null;
}

function resolveCollaborationHint(
  collaboration: UseBrowserControlResult["collaboration"],
): string | null {
  if (
    collaboration.holderClientId !== null &&
    collaboration.holderClientId !== collaboration.clientId
  ) {
    return "Input in use";
  }
  if (collaboration.hasControl) {
    return null;
  }
  if (
    collaboration.lastError?.code === "input_busy" ||
    collaboration.lastError?.code === "input_not_owned"
  ) {
    return "Input in use";
  }
  if (collaboration.lastError?.code === "input_unavailable") {
    return "Input unavailable";
  }
  return null;
}

function isInputOwnershipError(error: UseBrowserControlResult["collaboration"]["lastError"]) {
  return error?.code === "input_busy" || error?.code === "input_not_owned";
}

function setImageFrame(image: HTMLImageElement, frame: LiveSessionRasterFrame): void {
  const previousSource = image.src;
  image.src = URL.createObjectURL(frame.data);
  if (previousSource.startsWith("blob:")) {
    URL.revokeObjectURL(previousSource);
  }
}

function clearImageSource(image: HTMLImageElement): void {
  const source = image.src;
  image.removeAttribute("src");
  if (source.startsWith("blob:")) {
    URL.revokeObjectURL(source);
  }
}

function ViewportPlaceholder({
  phase,
  mediaPhase,
  switching,
}: {
  phase: UseBrowserControlResult["phase"];
  mediaPhase: UseBrowserControlResult["mediaPhase"];
  switching: boolean;
}) {
  if (phase === "connecting") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Connecting
      </div>
    );
  }
  if (phase === "connected" && mediaPhase === "connecting") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Connecting media
      </div>
    );
  }
  if (phase === "connected" && switching) {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Switching target
      </div>
    );
  }
  if (phase === "disconnected" || phase === "error") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Unplug className="size-5" />
        Disconnected
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      Waiting for frame
    </div>
  );
}

function StatusBadge({ status }: { status: "webrtc" | "websocket" | "stale" | "offline" }) {
  if (status === "webrtc" || status === "websocket") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      >
        {status}
      </Badge>
    );
  }
  if (status === "stale") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 bg-amber-500/15 text-amber-800 dark:text-amber-300"
      >
        <AlertCircle />
        stale
      </Badge>
    );
  }
  return <Badge variant="outline">offline</Badge>;
}

function resolveClipboardShortcut(event: KeyboardEvent): "copy" | "cut" | "paste" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return null;
  }

  switch (event.code) {
    case "KeyC":
      return "copy";
    case "KeyX":
      return "cut";
    case "KeyV":
      return "paste";
    default:
      return null;
  }
}

function resolveMouseButton(button: number): MouseButton {
  if (button === 0) {
    return "left";
  }
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  return "none";
}

function resolveClickCount(
  targetId: string,
  button: MouseButton,
  point: ViewportPoint,
  time: number,
  previous: {
    targetId: string;
    button: MouseButton;
    point: ViewportPoint;
    time: number;
    clickCount: number;
  } | null,
): number {
  if (
    previous &&
    previous.targetId === targetId &&
    previous.button === button &&
    time - previous.time <= MULTI_CLICK_MS &&
    Math.abs(previous.point.x - point.x) <= MULTI_CLICK_DISTANCE &&
    Math.abs(previous.point.y - point.y) <= MULTI_CLICK_DISTANCE
  ) {
    return Math.min(previous.clickCount + 1, 3);
  }
  return 1;
}

function mouseButtonsForButton(button: MouseButton): number {
  switch (button) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
    case "none":
      return 0;
    default: {
      const exhaustive: never = button;
      return exhaustive;
    }
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function wheelDeltaScale(deltaMode: number, viewportHeight: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return 16;
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return viewportHeight;
  }
  return 1;
}

async function pasteClipboard(control: UseBrowserControlResult) {
  if (!control.activeTargetId) {
    return;
  }

  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (error) {
    console.warn("Clipboard read failed", error);
    toast.error("Clipboard read failed");
    return;
  }

  if (!text) {
    return;
  }

  control.sendInput({
    type: "clipboard.paste",
    targetId: control.activeTargetId,
    items: [{ mimeType: "text/plain", data: text }],
  });
}

function resolveViewportStatus(
  phase: UseBrowserControlResult["phase"],
  hasFrame: boolean,
  frameStale: boolean,
  mediaPhase: UseBrowserControlResult["mediaPhase"],
  mediaPath: UseBrowserControlResult["mediaPath"],
  showingWebRTC: boolean,
): "webrtc" | "websocket" | "stale" | "offline" {
  if (phase !== "connected") {
    return "offline";
  }
  if (mediaPhase === "live" && showingWebRTC) {
    return "webrtc";
  }
  if (!hasFrame) {
    return "offline";
  }
  if (frameStale) {
    return "stale";
  }
  return mediaPath === "websocket-live" ? "websocket" : "webrtc";
}
