const nonce = new URLSearchParams(window.location.search).get("nonce");

if (nonce) {
  document.title = `Aperture Binding ${nonce}`;
}
