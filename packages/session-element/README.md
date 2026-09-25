# @aperture-browser/session-element

Custom elements that embed a live [Aperture](https://github.com/tarik02/aperture) browser session in any page. They render into Shadow DOM, so the page's styles and the session's never mix, and bundle React and everything else they need.

- `<aperture-session>`: the session with its UI: tabs, toolbar and menus.
- `<aperture-session-view>`: the session alone, for pages that build their own controls. It skips the UI kit, stylesheet and fonts, so it is much smaller.

## `<aperture-session>`

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@aperture-browser/session-element/dist/aperture-session.js"></script>

<aperture-session
  base-url="https://aperture.example"
  token="apv_…"
  style="display: block; height: 600px"
></aperture-session>
```

Or from a bundler: `import "@aperture-browser/session-element";`.

Attributes:

- `token`: a share link's editor (`ape_…`) or viewer (`apv_…`) token; the element grants exactly what the link grants.
- `base-url`: the Aperture instance, when it is not the page's own origin. The instance must list your origin in `embed_allowed_origins`.
- `hide`: parts of the UI to leave out, separated by spaces: `tabs`, `navigation` (back, forward, reload), `address-bar`, `presence`, `drawing`, `menus`, `status-badge`, `toaster`.
- `theme`: `light`, `dark` or `system` (the default).

The element fills the size you give it. It adds one `<style>` to the page for its font faces and CSS custom property registrations, which browsers ignore inside shadow roots. The Geist font files sit in `dist/files` next to the module, and browsers only download the subsets a page needs.

## `<aperture-session-view>`

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@aperture-browser/session-element/dist/aperture-session-view.js"></script>

<aperture-session-view id="session" base-url="https://aperture.example" token="ape_…"></aperture-session-view>

<script type="module">
  const session = document.getElementById("session");
  session.addEventListener("aperture-change", ({ detail }) => {
    console.log(detail.status, detail.tabs, detail.activeTabId);
  });
  session.navigate("https://example.com");
</script>
```

Or from a bundler: `import "@aperture-browser/session-element/headless";`.

It takes the `token` and `base-url` attributes and shows the active tab, forwarding input to it.

- `snapshot` holds the current state: `status` (`loading`, `ready`, `invalid`, `expired` or `unavailable`), `role`, `connection`, `tabs` (`id`, `title`, `url`, `loading`) and `activeTabId`. The `aperture-change` event carries each new snapshot.
- Methods: `navigate(url)`, `back()`, `forward()`, `reload()`, `stop()`, `openTab(url?)`, `closeTab(id)`, `activateTab(id)`, `reconnect()`. They act on the active tab where it applies, and do nothing until the session is connected.
- The `aperture-notice` event carries errors and confirmations (`level`, `message`) that `<aperture-session>` would show as toasts.

Both elements load a shared module next to them, so a page that uses both loads React and the session core once.

React apps that want to share their own React copy can use [`@aperture-browser/session-react`](https://www.npmjs.com/package/@aperture-browser/session-react) instead, which has the same full and headless split.
