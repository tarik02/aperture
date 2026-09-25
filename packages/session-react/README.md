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
- `tabs`: `false` shows the active tab without the tab strip.
- `theme`: `"light"`, `"dark"` or `"system"` (the default).
- `toaster`: `false` if your app renders its own [sonner](https://sonner.emilkowal.ski) toaster.

## Styles

`styles.css` styles everything inside the component's `.aperture-root` element: theme colors, a scoped reset and the Geist font. It does not touch your page's `html`, `body` or `:root`, and menus and tooltips render inside the root. It does include Tailwind utility classes, which your own unlayered CSS can override. For full isolation use [`@aperture-browser/session-element`](https://www.npmjs.com/package/@aperture-browser/session-element), which renders into Shadow DOM.

## Lower-level pieces

`SharedSession` is the same view without its own runtime, tooltip provider and toaster, for apps that provide them (`RuntimeProvider` with `makeApertureRuntime`, and `TooltipProvider`). `useBrowserControl` and `BrowserControlPane` drive and render a session for other credentials. These are what the Aperture web app is built from.

Requires `effect` 4 and React 19.
