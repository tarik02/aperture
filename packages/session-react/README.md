# @aperture-browser/session-react

React components and hooks for embedding a live [Aperture](https://github.com/tarik02/aperture) browser session, with the built-in UI or headless.

```sh
npm install @aperture-browser/session-react effect react react-dom
```

```tsx
import { useMemo } from "react";
import { ApertureSession, shareSessionAccess } from "@aperture-browser/session-react";
import "@aperture-browser/session-react/styles.css";

export function SharedBrowser({ token }: { token: string }) {
  const access = useMemo(() => shareSessionAccess(token, "https://aperture.example"), [token]);
  return (
    <div style={{ height: 600 }}>
      <ApertureSession access={access} />
    </div>
  );
}
```

`@aperture-browser/session-react/headless` has the same session without any UI, for apps that build their own controls.

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/session-react

For consumer-authenticated access, pass a stable `access` object with `{ kind: "relay", baseUrl: "/aperture", sessionId }`. Your backend owns authentication through `@aperture-browser/session-relay`; the browser sends no Aperture credentials. `useSession({ access })` exposes the same connection headlessly.
