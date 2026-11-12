# @aperture-browser/live-session

The framework-agnostic client for [Aperture](https://github.com/tarik02/aperture) live sessions:

- the `aperture-session.v1` protocol, decoded with Effect Schema;
- `LiveSessionConnection.make`, a scoped Effect that connects over WebRTC and falls back to WebSocket raster frames;
- clipboard reads and writes over that connection, and helpers that map DOM keyboard and pointer events to browser input messages, and viewport math.

For a ready-made UI, see [`@aperture-browser/session-react`](https://www.npmjs.com/package/@aperture-browser/session-react). Requires `effect` 4.

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/live-session

## Server compatibility

When the `autoSize` connection option is set, the hello carries an `autoSize` field that opts the client into viewport ownership. When the `clipboard` connection option is set, the hello carries a `clipboard` field that opts it into browser clipboard state and the `clipboard.read`/`clipboard.write` commands. Servers without viewport ownership (before [#126](https://github.com/tarik02/aperture/pull/126), the first nightly after it) reject the `autoSize` hello; servers before [#204](https://github.com/tarik02/aperture/pull/204) reject the `clipboard` one. Use this package with a server at least as new as it, or leave those options unset.
