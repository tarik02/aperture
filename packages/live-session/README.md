# @aperture-browser/live-session

The framework-agnostic client for [Aperture](https://github.com/tarik02/aperture) live sessions:

- the `aperture-session.v1` protocol, decoded with Effect Schema;
- `LiveSessionConnection.make`, a scoped Effect that connects over WebRTC and falls back to WebSocket raster frames;
- helpers that map DOM keyboard and pointer events to browser input messages, and viewport math.

For a ready-made UI, see [`@aperture-browser/session-react`](https://www.npmjs.com/package/@aperture-browser/session-react). Requires `effect` 4.

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/live-session
