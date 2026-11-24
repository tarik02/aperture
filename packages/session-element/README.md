# @aperture-browser/session-element

`<aperture-session>`: one [Aperture](https://github.com/tarik02/aperture) session in any page, as a custom element with the workbench's tab strip, toolbar and menus in a shadow tree. It brings React with it and asks nothing of the page.

```sh
npm install @aperture-browser/session-element@beta
```

While Aperture is in beta its packages are under the dist-tag `beta`; a package has the version of the server it speaks to.

```html
<script type="module">
  import "@aperture-browser/session-element";
</script>

<aperture-session
  url="https://aperture.example.com/n/NODE/sessions/SESSION"
  token="TICKET"
  name="Ada"
  theme="system"
  hide="recordings files"
  style="height: 100dvh"
></aperture-session>
```

`url` is the session's base and `token` a ticket your backend asked the control plane for. `hide` names the parts to leave out: `tabs navigation address-bar presence menus files recordings page-menu sound toaster`. From script, the `features` and `contributions` properties do the same and more, `session` is the session's client, and the `aperture-session` event tells when there is one.
