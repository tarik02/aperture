# @aperture-browser/session-react

React components for embedding a live [Aperture](https://github.com/tarik02/aperture) browser session.

```sh
npm install @aperture-browser/session-react effect react react-dom
```

```tsx
import { ApertureSession } from "@aperture-browser/session-react";
import "@aperture-browser/session-react/styles.css";

export function SharedBrowser({ token }: { token: string }) {
  return (
    <div style={{ height: 600 }}>
      <ApertureSession baseUrl="https://aperture.example" token={token} />
    </div>
  );
}
```

`token` is a share link's editor (`ape_…`) or viewer (`apv_…`) token; the component grants exactly what the link grants. Props:

- `baseUrl`: the Aperture instance, when it is not the page's own origin. The instance must list your origin in `embed_allowed_origins`.
- `features`: turns parts of the UI off, e.g. `{ tabs: false, menus: false }`. Each defaults to on: `tabs`, `navigation` (back, forward, reload), `addressBar`, `presence` (who else is connected), `drawing`, `menus` (stream, viewport, recording and input settings), `statusBadge`.
- `theme`: `"light"`, `"dark"` or `"system"` (the default).
- `toaster`: `false` if your app renders its own [sonner](https://sonner.emilkowal.ski) toaster.

## Styles

`styles.css` styles everything inside the component's `.aperture-root` element: theme colors and a scoped reset. It does not touch your page's `html`, `body` or `:root`, and menus and tooltips render inside the root. It does include Tailwind utility classes, which your own unlayered CSS can override. For full isolation use [`@aperture-browser/session-element`](https://www.npmjs.com/package/@aperture-browser/session-element), which renders into Shadow DOM.

The component uses your page's font. To pick others, set `--aperture-font-sans` and `--aperture-font-mono` (used for URLs) on it or any ancestor, e.g. `--aperture-font-sans: "Inter", sans-serif`.

## Headless

`@aperture-browser/session-react/headless` has the session without any UI: no tab strip, toolbar, menus, stylesheet or UI dependencies. Build your own controls around it.

```tsx
import {
  ApertureProvider,
  SessionViewport,
  useSharedSession,
} from "@aperture-browser/session-react/headless";

function Browser({ token }: { token: string }) {
  const { status, control } = useSharedSession({ token, onNotice: console.warn });
  if (status !== "ready") return <p>{status}</p>;
  return (
    <>
      {control.targets.map((tab) => (
        <button key={tab.id} onClick={() => control.activateTarget(tab.id)}>
          {tab.title}
        </button>
      ))}
      <button onClick={() => control.historyBack()}>Back</button>
      <SessionViewport control={control} style={{ height: 600 }} />
    </>
  );
}

export const App = ({ token }: { token: string }) => (
  <ApertureProvider baseUrl="https://aperture.example">
    <Browser token={token} />
  </ApertureProvider>
);
```

- `useSharedSession` resolves the token (`status` is `loading`, `ready`, `invalid`, `expired` or `unavailable`) and connects once it is ready. `control` lists the tabs and navigates, opens, closes and activates them.
- `SessionViewport` shows the active tab and forwards input to it. It is styled inline and takes `className` and `style`. `renderOverlay` receives the connection status, a placeholder reason while there is no picture yet, and cursor hints, for drawing your own overlays.
- `onNotice` receives the errors and confirmations the full UI shows as toasts.

## Lower-level pieces

`SharedSession` is the same view without its own runtime, tooltip provider and toaster, for apps that provide them (`RuntimeProvider` with `makeApertureRuntime`, and `TooltipProvider`). `useBrowserControl` and `BrowserControlPane` drive and render a session for other credentials. These are what the Aperture web app is built from.

Requires `effect` 4 and React 19.
