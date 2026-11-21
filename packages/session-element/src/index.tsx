import { createRoot, type Root } from "react-dom/client";
import {
  ApertureSession,
  type ApertureSessionFeatures,
  type ApertureTheme,
  type PictureWay,
  type Session,
  type WorkbenchContributions,
} from "@aperture-browser/session-react";
import styles from "@aperture-browser/session-react/styles.css?inline";
// The notices put their styles into the document, which a shadow tree does not take.
import noticeStyles from "sonner/dist/styles.css?inline";

// Registered properties are the document's: one declared in a shadow tree is not known.
const documentRules = /@property[^{]*\{[^}]*\}/gu;
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

const hideableFeatures = {
  tabs: "tabs",
  navigation: "navigation",
  "address-bar": "addressBar",
  presence: "presence",
  menus: "menus",
  files: "files",
  recordings: "recordings",
  "page-menu": "pageMenu",
  sound: "sound",
  toaster: "toaster",
} as const satisfies Record<string, keyof ApertureSessionFeatures>;

const isHideable = (name: string): name is keyof typeof hideableFeatures =>
  name in hideableFeatures;

function hiddenFeatures(value: string | null): ApertureSessionFeatures {
  const features: { -readonly [K in keyof ApertureSessionFeatures]: boolean } = {};
  for (const name of value?.split(/\s+/u) ?? []) {
    if (isHideable(name)) {
      features[hideableFeatures[name]] = false;
    }
  }
  return features;
}

const isTheme = (value: string | null): value is ApertureTheme =>
  value === "light" || value === "dark" || value === "system";

const isWay = (value: string | null): value is PictureWay =>
  value === "video" || value === "frames" || value === "tiles";

/**
 * `<aperture-session url="…" token="…" name="…">`: the workbench of one session, apart from
 * the page's own styles in a shadow tree. `hide` names the parts to leave out, separated by
 * spaces; the `features` property does the same from script and wins over it.
 */
export class ApertureSessionElement extends HTMLElement {
  static readonly observedAttributes = ["url", "token", "name", "pixels", "theme", "hide"];

  #root: Root | null = null;
  #session: Session | null = null;
  #features: ApertureSessionFeatures = {};

  get features(): ApertureSessionFeatures {
    return this.#features;
  }

  set features(features: ApertureSessionFeatures) {
    this.#features = features;
    this.#render();
  }

  #contributions: WorkbenchContributions | undefined;

  /**
   * What is added to the workbench's slots, or put in place of its own; see
   * `WorkbenchContribution` of `@aperture-browser/session-react`. From script only.
   */
  get contributions(): WorkbenchContributions | undefined {
    return this.#contributions;
  }

  set contributions(contributions: WorkbenchContributions | undefined) {
    this.#contributions = contributions;
    this.#render();
  }

  /** The session's client, while the element is connected to its session. */
  get session(): Session | null {
    return this.#session;
  }

  connectedCallback(): void {
    installDocumentStyles(this.ownerDocument);
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `${hostStyles}\n${styles}\n${noticeStyles}`;
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

  readonly #heard = (session: Session | null) => {
    this.#session = session;
    this.dispatchEvent(new CustomEvent("aperture-session", { detail: session }));
  };

  #render(): void {
    const url = this.getAttribute("url");
    const theme = this.getAttribute("theme");
    const pixels = this.getAttribute("pixels");
    this.#root?.render(
      url === null ? null : (
        <ApertureSession
          url={url}
          token={this.getAttribute("token") ?? undefined}
          name={this.getAttribute("name") ?? undefined}
          pixels={isWay(pixels) ? pixels : undefined}
          theme={isTheme(theme) ? theme : "system"}
          features={{ ...hiddenFeatures(this.getAttribute("hide")), ...this.#features }}
          contributions={this.#contributions}
          onSession={this.#heard}
        />
      ),
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
