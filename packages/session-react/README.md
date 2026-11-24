# @aperture-browser/session-react

React components for watching and controlling one [Aperture](https://github.com/tarik02/aperture) session: the workbench with its tab strip, toolbar and menus, or the picture alone.

```sh
npm install @aperture-browser/session-react@beta react react-dom effect
```

While Aperture is in beta its packages are under the dist-tag `beta`; a package has the version of the server it speaks to.

```tsx
import { ApertureSession } from "@aperture-browser/session-react";
import "@aperture-browser/session-react/styles.css";

// `url` is the session's base; `token` a ticket your backend asked the control plane for.
export function Browser({ url, token }: { url: string; token: string }) {
  return <ApertureSession url={url} token={token} name="Ada" theme="system" />;
}
```

`features` turns parts of the workbench off (`{ tabs: false, recordings: false }`); `contributions` adds to its slots, replaces what is in them and leaves things out. `@aperture-browser/session-react/headless` has the hooks and the picture without the workbench's styles.

A ticket runs out: ask for a fresh one when the page is opened again.
