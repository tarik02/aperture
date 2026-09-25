import { createRoot, type Root } from "react-dom/client";
import { ApertureSession, type SessionFeatures } from "@aperture-browser/session-react";
import styles from "@aperture-browser/session-react/styles.css?inline";

const documentRules = /@property[^{]*\{[^}]*\}/g;
const installedDocuments = new WeakSet<Document>();

function installDocumentStyles(document: Document) {
  if (installedDocuments.has(document)) {
    return;
  }
  installedDocuments.add(document);
  const style = document.createElement("style");
  style.dataset.apertureSession = "";
  style.textContent = Array.from(styles.matchAll(documentRules), ([rule]) => rule).join("\n");
  document.head.append(style);
}

const hostStyles = `
:host { display: block; position: relative; overflow: hidden; }
:host([hidden]) { display: none; }
.mount { height: 100%; }
`;

type Theme = "light" | "dark" | "system";

const hideableFeatures = {
  tabs: "tabs",
  navigation: "navigation",
  "address-bar": "addressBar",
  presence: "presence",
  drawing: "drawing",
  menus: "menus",
  "status-badge": "statusBadge",
} as const satisfies Record<string, keyof SessionFeatures>;

function hiddenFeatures(value: string | null): SessionFeatures {
  const features: { -readonly [K in keyof SessionFeatures]: SessionFeatures[K] } = {};
  for (const name of value?.split(/\s+/) ?? []) {
    if (name in hideableFeatures) {
      features[hideableFeatures[name as keyof typeof hideableFeatures]] = false;
    }
  }
  return features;
}

export class ApertureSessionElement extends HTMLElement {
  static readonly observedAttributes = ["token", "base-url", "theme", "hide"];

  #root: Root | null = null;

  connectedCallback(): void {
    installDocumentStyles(this.ownerDocument);
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `${hostStyles}\n${styles}`;
    const mount = document.createElement("div");
    mount.className = "mount";
    shadow.append(style, mount);
    this.#root = createRoot(mount);
    this.#render();
  }

  disconnectedCallback(): void {
    this.#root?.unmount();
    this.#root = null;
  }

  attributeChangedCallback(): void {
    this.#render();
  }

  #render(): void {
    const token = this.getAttribute("token");
    const theme = this.getAttribute("theme");
    this.#root?.render(
      token ? (
        <ApertureSession
          key={this.getAttribute("base-url") ?? ""}
          token={token}
          baseUrl={this.getAttribute("base-url") ?? undefined}
          theme={theme === "light" || theme === "dark" ? (theme as Theme) : "system"}
          features={hiddenFeatures(this.getAttribute("hide"))}
          toaster={!this.getAttribute("hide")?.split(/\s+/).includes("toaster")}
        />
      ) : null,
    );
  }
}

if (!customElements.get("aperture-session")) {
  customElements.define("aperture-session", ApertureSessionElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "aperture-session": ApertureSessionElement;
  }
}
