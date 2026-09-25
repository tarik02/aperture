# @aperture-browser/session-react

React components and hooks for embedding a live [Aperture](https://github.com/tarik02/aperture) browser session, with the built-in UI or headless.

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

`@aperture-browser/session-react/headless` has the same session without any UI, for apps that build their own controls.

Documentation: https://aperture-docs-1sd.pages.dev/docs/packages/session-react
