# @aperture-browser/session-client

A framework-free client for one [Aperture](https://github.com/tarik02/aperture) session in a browser: the live protocol, the session's picture and sound, input, and its HTTP routes. For a ready-made workbench use `@aperture-browser/session-react` or `@aperture-browser/session-element`.

```sh
npm install @aperture-browser/session-client@beta effect
```

While Aperture is in beta its packages are under the dist-tag `beta`; a package has the version of the server it speaks to.

```ts
import { connect } from "@aperture-browser/session-client";

// `url` is the session's base; `token` a ticket from the control plane.
const session = connect({ url: "https://aperture.example.com/n/<node>/sessions/<id>", token: ticket });

const detach = session.attach({
  video: document.querySelector("video")!,
  canvas: document.querySelector("canvas")!,
  keys: document.querySelector("textarea")!,
  stage: document.querySelector<HTMLElement>("#stage")!,
});

session.subscribe(() => {
  const { targets, selected } = session.getSnapshot();
  console.log(targets.map((target) => target.title), selected);
});
session.go({ url: "https://example.com" });

// Later:
detach();
session.close();
```

`getSnapshot` and `subscribe` are a store, as `useSyncExternalStore` takes one. What is sent over the session socket is not answered: its effect shows in the snapshot. The session's HTTP routes (`recordings`, `pace`, `screenshots`, `upload`, `storageState`) return promises that reject with `SessionError`.

`@aperture-browser/session-client/effect` has the same client as an Effect service, with the generated protocol messages.
