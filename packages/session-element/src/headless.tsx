import { useEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ApertureProvider,
  SessionViewport,
  useSharedSession,
  type SessionNotice,
  type UseBrowserControlResult,
} from "@aperture-browser/session-react/headless";

export interface ApertureTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly loading: boolean;
}

export interface ApertureSessionSnapshot {
  readonly status: "invalid" | "loading" | "expired" | "unavailable" | "ready";
  readonly role: "editor" | "viewer" | null;
  readonly connection: "idle" | "connecting" | "connected" | "disconnected" | "error";
  readonly tabs: readonly ApertureTab[];
  readonly activeTabId: string | null;
}

export interface ApertureNotice {
  readonly level: "error" | "success";
  readonly message: string;
}

const initialSnapshot: ApertureSessionSnapshot = {
  status: "loading",
  role: null,
  connection: "idle",
  tabs: [],
  activeTabId: null,
};

const hostStyles = `
:host { display: block; position: relative; overflow: hidden; }
:host([hidden]) { display: none; }
.mount { display: flex; height: 100%; }
`;

interface HeadlessSessionProps {
  readonly token: string;
  readonly onControl: (control: UseBrowserControlResult) => void;
  readonly onSnapshot: (snapshot: ApertureSessionSnapshot) => void;
  readonly onNotice: (notice: SessionNotice) => void;
}

function HeadlessSession({ token, onControl, onSnapshot, onNotice }: HeadlessSessionProps) {
  const { status, share, control } = useSharedSession({ token, onNotice });
  const snapshot = useMemo<ApertureSessionSnapshot>(
    () => ({
      status,
      role: share?.role ?? null,
      connection: control.phase,
      tabs: control.targets.map(({ id, title, url, loading }) => ({ id, title, url, loading })),
      activeTabId: control.activeTargetId,
    }),
    [control.activeTargetId, control.phase, control.targets, share, status],
  );

  useEffect(() => onControl(control));
  useEffect(() => onSnapshot(snapshot), [onSnapshot, snapshot]);

  return status === "ready" ? <SessionViewport control={control} /> : null;
}

export class ApertureSessionViewElement extends HTMLElement {
  static readonly observedAttributes = ["token", "base-url"];

  #root: Root | null = null;
  #control: UseBrowserControlResult | null = null;
  #snapshot = initialSnapshot;

  get snapshot(): ApertureSessionSnapshot {
    return this.#snapshot;
  }

  navigate(url: string): void {
    this.#control?.navigate(url);
  }

  back(): void {
    this.#control?.historyBack();
  }

  forward(): void {
    this.#control?.historyForward();
  }

  reload(): void {
    const tabId = this.#control?.activeTargetId;
    if (tabId) {
      this.#control?.reload(tabId);
    }
  }

  stop(): void {
    this.#control?.stopLoading();
  }

  openTab(url?: string): void {
    this.#control?.createTarget(url);
  }

  closeTab(tabId: string): void {
    this.#control?.closeTarget(tabId);
  }

  activateTab(tabId: string): void {
    this.#control?.activateTarget(tabId);
  }

  reconnect(): void {
    this.#control?.reconnect();
  }

  connectedCallback(): void {
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = hostStyles;
    const mount = document.createElement("div");
    mount.className = "mount";
    shadow.append(style, mount);
    this.#root = createRoot(mount);
    this.#render();
  }

  disconnectedCallback(): void {
    this.#root?.unmount();
    this.#root = null;
    this.#control = null;
  }

  attributeChangedCallback(): void {
    this.#render();
  }

  #setControl = (control: UseBrowserControlResult): void => {
    this.#control = control;
  };

  #setSnapshot = (snapshot: ApertureSessionSnapshot): void => {
    if (JSON.stringify(snapshot) === JSON.stringify(this.#snapshot)) {
      return;
    }
    this.#snapshot = snapshot;
    this.dispatchEvent(new CustomEvent("aperture-change", { detail: snapshot }));
  };

  #notice = (notice: ApertureNotice): void => {
    this.dispatchEvent(new CustomEvent("aperture-notice", { detail: notice }));
  };

  #render(): void {
    const token = this.getAttribute("token");
    const baseUrl = this.getAttribute("base-url") ?? undefined;
    this.#root?.render(
      token ? (
        <ApertureProvider key={baseUrl ?? ""} baseUrl={baseUrl}>
          <HeadlessSession
            token={token}
            onControl={this.#setControl}
            onSnapshot={this.#setSnapshot}
            onNotice={this.#notice}
          />
        </ApertureProvider>
      ) : null,
    );
  }
}

if (!customElements.get("aperture-session-view")) {
  customElements.define("aperture-session-view", ApertureSessionViewElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "aperture-session-view": ApertureSessionViewElement;
  }
  interface HTMLElementEventMap {
    "aperture-change": CustomEvent<ApertureSessionSnapshot>;
    "aperture-notice": CustomEvent<ApertureNotice>;
  }
}
