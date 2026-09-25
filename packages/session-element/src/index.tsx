import { createRoot, type Root } from "react-dom/client";
import { ApertureSession } from "@aperture-browser/session-react";
import styles from "@aperture-browser/session-react/styles.css?inline";

const documentRules = /@(?:font-face|property)[^{]*\{[^}]*\}/g;
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

export class ApertureSessionElement extends HTMLElement {
  static readonly observedAttributes = ["token", "base-url", "theme", "hide-tabs"];

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
          tabs={!this.hasAttribute("hide-tabs")}
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
