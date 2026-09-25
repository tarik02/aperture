# @aperture-browser/session-element

`<aperture-session>`: a custom element that embeds a live [Aperture](https://github.com/tarik02/aperture) browser session in any page. It renders into Shadow DOM, so the page's styles and the session's never mix. React, the session UI, its styles and fonts are bundled into one module.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@aperture-browser/session-element"></script>

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
- `hide-tabs`: shows the active tab without the tab strip.
- `theme`: `light`, `dark` or `system` (the default).

The element fills the size you give it. It adds one `<style>` to the page for its font faces and CSS custom property registrations, which browsers ignore inside shadow roots.

React apps that want to share their own React copy can use [`@aperture-browser/session-react`](https://www.npmjs.com/package/@aperture-browser/session-react) instead.
