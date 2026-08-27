---
status: accepted
---

# Keep live session semantics in Aperture

Aperture will own live session protocol decoding, session-client identity, authorization, input leasing, state, and transport handover. The `webdesktop` package will expose generic peer lifecycle, application metadata, and reliable and realtime data-channel hooks without learning Aperture targets, capabilities, presence, or collaboration rules. This preserves `webdesktop` as reusable WebRTC and media infrastructure while avoiding a second implementation of session authority in its existing fixed input channels.
