# Changelog

## [1.0.0-beta.7](https://github.com/tarik02/aperture/compare/v1.0.0-beta.6...v1.0.0-beta.7) (2026-11-28)


### Bug Fixes

* give sessions their menu in the tabs view ([#270](https://github.com/tarik02/aperture/issues/270)) ([07eb825](https://github.com/tarik02/aperture/commit/07eb825b2672887db8f26e0352ea09ebf2d4c12f))

## [1.0.0-beta.6](https://github.com/tarik02/aperture/compare/v1.0.0-beta.5...v1.0.0-beta.6) (2026-11-28)


### Bug Fixes

* keep suspended sessions and their tabs in place on the sessions page ([#267](https://github.com/tarik02/aperture/issues/267)) ([ff0b70f](https://github.com/tarik02/aperture/commit/ff0b70ffa865bb035bbe3f8b916a5a9c2dd6dfd7))
* take a key that is down already as still down, not pressed once more ([#268](https://github.com/tarik02/aperture/issues/268)) ([1ef05d1](https://github.com/tarik02/aperture/commit/1ef05d1fa440fee6702d218f12adb703b677cc54))

## [1.0.0-beta.5](https://github.com/tarik02/aperture/compare/v1.0.0-beta.4...v1.0.0-beta.5) (2026-11-28)


### Features

* resumable uploads up to a size an admin sets, refused early past it ([#265](https://github.com/tarik02/aperture/issues/265)) ([65e8935](https://github.com/tarik02/aperture/commit/65e8935efa3a743ae3efdd4c31ce5014f2145bbf))


### Bug Fixes

* let go of keys a client holds when their release never comes ([#264](https://github.com/tarik02/aperture/issues/264)) ([54c7312](https://github.com/tarik02/aperture/commit/54c7312078e23b0ef147013d94ba770ff477f803))

## [1.0.0-beta.4](https://github.com/tarik02/aperture/compare/v1.0.0-beta.3...v1.0.0-beta.4) (2026-11-27)


### Bug Fixes

* keep the number typed when a setting's unit changes ([#258](https://github.com/tarik02/aperture/issues/258)) ([4100dba](https://github.com/tarik02/aperture/commit/4100dbaa2421100463ff650bd53eef844a8ad3a4))
* no "new version" toast while the build is the same ([#260](https://github.com/tarik02/aperture/issues/260)) ([468364a](https://github.com/tarik02/aperture/commit/468364ab169b98861b6120bb18558effb2af510f))
* wake a session that sat idle when it is opened ([#261](https://github.com/tarik02/aperture/issues/261)) ([8ac1d88](https://github.com/tarik02/aperture/commit/8ac1d888524cc9450b9f528a68b9c10465c6a458))

## [1.0.0-beta.3](https://github.com/tarik02/aperture/compare/v1.0.0-beta.2...v1.0.0-beta.3) (2026-11-26)


### Features

* serve Prometheus metrics from the control plane and each node ([#252](https://github.com/tarik02/aperture/issues/252)) ([ca16ea0](https://github.com/tarik02/aperture/commit/ca16ea0c014f4c2e38f75eb26a94ee7332091b41))
* settings at four levels: lifecycle, quotas, data policy, edited in place ([#248](https://github.com/tarik02/aperture/issues/248)) ([884ca19](https://github.com/tarik02/aperture/commit/884ca19769a50b6c1b29b0d29bdd680571d164f9))
* share a session for nobody named, or one tab of it alone, and let whoever opens the link in at once ([#255](https://github.com/tarik02/aperture/issues/255)) ([d583b72](https://github.com/tarik02/aperture/commit/d583b7237617c6f76e3ad0505026f9546a37c002))
* show a session's tabs in the console, and open it on the tab watched last ([#247](https://github.com/tarik02/aperture/issues/247)) ([5c615c5](https://github.com/tarik02/aperture/commit/5c615c5054ed9b1f523b36b4f9510ed9d0ee8dd5))


### Bug Fixes

* keep a node's running sessions over a stop of its unit, and stop the runners left without their state ([#249](https://github.com/tarik02/aperture/issues/249)) ([12c3146](https://github.com/tarik02/aperture/commit/12c314652e111a0912f7fc6f162d0bc769be2d81))
* let a password manager fill the two-factor code ([#257](https://github.com/tarik02/aperture/issues/257)) ([c9e1f50](https://github.com/tarik02/aperture/commit/c9e1f5040fe92f6afb85dc1a582fe21306509709))
* show the page menu for a right click in a frame of another site ([#244](https://github.com/tarik02/aperture/issues/244)) ([94b599d](https://github.com/tarik02/aperture/commit/94b599d32d4b6c4c2cf3574b6eb1e776bd14dc9f))

## [1.0.0-beta.2](https://github.com/tarik02/aperture/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2026-11-25)


### Features

* **console:** show the running version, and give tables a border whose shadows do not slide in ([#234](https://github.com/tarik02/aperture/issues/234)) ([59d41af](https://github.com/tarik02/aperture/commit/59d41afe44de7f3eeeb5b7fe9a727f9f25003764))
* let an admin read a workspace they are not in, and act there once they join it ([#241](https://github.com/tarik02/aperture/issues/241)) ([64beaa3](https://github.com/tarik02/aperture/commit/64beaa310e33e710bde897e76b8bc3fe8b364b23))
* **migrate:** keep v1's API tokens, passwords and second factors working ([#236](https://github.com/tarik02/aperture/issues/236)) ([dfc150d](https://github.com/tarik02/aperture/commit/dfc150d7aff519b95107fa432692700e3bf51a19))
* say the commit a build was made from beside its version: between releases every build from the tree has the last release's version, and nobody could tell which commit a deployment runs ([#240](https://github.com/tarik02/aperture/issues/240)) ([2f59111](https://github.com/tarik02/aperture/commit/2f5911178f67e7ca4534cd0c88699ffe4ff60b01))


### Bug Fixes

* **console:** resume a session that rests when it is opened, connect once it runs again, and keep a card's picture until the next has come ([#231](https://github.com/tarik02/aperture/issues/231)) ([c68ff11](https://github.com/tarik02/aperture/commit/c68ff1114f28ec9425bf598efc1ac91928fb1287))
* **control:** list a session's tools on the MCP server before any session runs ([#235](https://github.com/tarik02/aperture/issues/235)) ([82ae372](https://github.com/tarik02/aperture/commit/82ae372999aeee699ef74ed51655a6cced93ef4b))
* **deploy:** what a compose deployment under podman stumbled on ([#230](https://github.com/tarik02/aperture/issues/230)) ([dd8c932](https://github.com/tarik02/aperture/commit/dd8c9329d3a18349376fb6c51a9099b4b54545d4))
* keep typing in an edit that cuts what is idle: a call counts only where it starts since a click's wait for a held tab was kept, and a typed letter changes too few pixels to count, so typing a field showed its first letters and then the whole text at once; each key and typed character now goes into the journal, as the pointer's moves and presses do, and the edit counts them ([#242](https://github.com/tarik02/aperture/issues/242)) ([4b73645](https://github.com/tarik02/aperture/commit/4b73645434a5e645a97d4565014732819c9c6198))
* let the session's extension take over in a profile an earlier build's ran in ([#243](https://github.com/tarik02/aperture/issues/243)) ([9d95144](https://github.com/tarik02/aperture/commit/9d95144a0efebc6624f42e071effdc92e376724e))
* **migrate:** make each system administrator of v1 an admin of every shared workspace ([#239](https://github.com/tarik02/aperture/issues/239)) ([39159f8](https://github.com/tarik02/aperture/commit/39159f8fb64b7f6a1f765b78a17340f15deb69c3))
* **recording:** have a travel that waited for its tab still travel, keep a caption for as long as it shows, and cut a call's wait ([#238](https://github.com/tarik02/aperture/issues/238)) ([a2f0ff4](https://github.com/tarik02/aperture/commit/a2f0ff44cf5e1fa43ec600e5c30305882949f298))
* send a tab's picture first at its new size, and keep a picture of another shape in its tab's place ([#232](https://github.com/tarik02/aperture/issues/232)) ([86bc786](https://github.com/tarik02/aperture/commit/86bc786e8ff7536cf0aca253f9cda354ec630a5e))
* what made the control plane's checks fail on master ([#237](https://github.com/tarik02/aperture/issues/237)) ([78cceab](https://github.com/tarik02/aperture/commit/78cceab009e74acdd6b9d2226b5e2e0d92bd0cd0))

## 1.0.0-beta.1 (2026-11-24)


### Features

* a documentation site for v2 ([#221](https://github.com/tarik02/aperture/issues/221)) ([2ddf027](https://github.com/tarik02/aperture/commit/2ddf027fe0364ecd1d2f0f919e6cbf024a9b08f5))
* aperture v2, the session runner and executor in Rust ([#217](https://github.com/tarik02/aperture/issues/217)) ([0840215](https://github.com/tarik02/aperture/commit/08402157055a65d07489d4ecc28252139373205b))
* choose how a recording is cut when it stops, and cut it again ([#224](https://github.com/tarik02/aperture/issues/224)) ([a9b372c](https://github.com/tarik02/aperture/commit/a9b372c31b2af4b2170b1014771f65068e3c76fd))
* **console:** group what a client asks for, and pick what it is limited to in one place ([#222](https://github.com/tarik02/aperture/issues/222)) ([6c19cc5](https://github.com/tarik02/aperture/commit/6c19cc53471e731b8f6900935cd718ca29421cff))
* deploy with docker compose ([#219](https://github.com/tarik02/aperture/issues/219)) ([8763552](https://github.com/tarik02/aperture/commit/87635522cd0024bef33bf93beb10b2b92d8db8a3))
* make the first admin from a logged link, and delete nothing from the database ([#220](https://github.com/tarik02/aperture/issues/220)) ([d22ea4d](https://github.com/tarik02/aperture/commit/d22ea4d4437fe089e9fd6ad5d64095940fe04617))
* the companion extension, on v2 ([#225](https://github.com/tarik02/aperture/issues/225)) ([e9ed26e](https://github.com/tarik02/aperture/commit/e9ed26eebaf298bc0263401b63b302ea0199d4b2))


### Bug Fixes

* **console:** say that Aperture is not answering, and ask it again with a pause ([#226](https://github.com/tarik02/aperture/issues/226)) ([86df3ff](https://github.com/tarik02/aperture/commit/86df3ffe328b9d2876719988d50c6ea2a8cd0228))
* what made five checks that drive a browser fail now and then ([#229](https://github.com/tarik02/aperture/issues/229)) ([236a188](https://github.com/tarik02/aperture/commit/236a1884339d94b1820474a8010ee87e36d1af56))
