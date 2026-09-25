# @aperture-browser/session-element

Custom elements that embed a live [Aperture](https://github.com/tarik02/aperture) browser session in any page, isolated in Shadow DOM.

- `<aperture-session>`: the session with its UI: tabs, toolbar and menus.
- `<aperture-session-view>`: the session alone, with a JavaScript API for pages that build their own controls.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@aperture-browser/session-element/dist/aperture-session.js"></script>

<aperture-session
  base-url="https://aperture.example"
  token="apv_…"
  style="display: block; height: 600px"
></aperture-session>
```

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/session-element
