# Docker

The Docker image contains the complete Aperture runtime: Chromium, the WebRTC media stack, the patched Weston compositor, GStreamer, PipeWire/WirePlumber, bubblewrap, agent-browser, Traefik, and s6-overlay. It is available for Linux amd64 and arm64.

Stable and nightly multi-architecture images are published to GitHub Container Registry:

```text
ghcr.io/tarik02/aperture:<version>
ghcr.io/tarik02/aperture:latest
ghcr.io/tarik02/aperture:nightly
ghcr.io/tarik02/aperture:nightly-<commit>
```

## Build

Build the image on the target architecture and load it into Docker:

```bash
nix build .#aperture-docker
docker load < result
```

The image is tagged with the source revision. Set `APERTURE_IMAGE` to the tag printed by `docker load` when using Compose.

## Run

```bash
export APERTURE_EXTERNAL_BASE_URL=https://aperture.example.com
export APERTURE_IMAGE=aperture:SOURCE_REVISION
docker compose -f packaging/docker/compose.yaml up -d
```

The base Compose definition uses Linux host networking so WebRTC advertises the Docker host's reachable LAN addresses instead of container bridge addresses. Traefik listens on TCP port `8080` and WebRTC ICE uses UDP ports `50000-50010`. Put TLS or an external ingress in front of port `8080` when the public URL uses HTTPS, and allow or forward the UDP range to the host for direct WebRTC connectivity.

The base Compose definition runs without a GPU. It grants `CAP_SYS_ADMIN` for overlay mounts, allocates 2 GiB of shared memory, persists all state in the `aperture-data` volume, and keeps `/run/aperture` ephemeral. Replacing the container may terminate active browser sessions; the Docker deployment does not provide blue/green rollout semantics.

To expose the host DRM devices, add the GPU override:

```bash
docker compose \
  -f packaging/docker/compose.yaml \
  -f packaging/docker/compose.gpu.yaml \
  up -d
```

The container adds the `aperture` user to the groups owning the supplied DRM devices. The same image contains Mesa VA drivers and, on amd64, Intel media drivers.

GPU selection is controlled by `APERTURE_GPU_MODE`:

- `auto` selects the full hardware path only when a render node and the requested VA-API pipeline pass preflight; otherwise it selects software before the session starts.
- `software` ignores supplied DRM devices and uses software GL with VP8 when the codec is `auto`.
- `hardware` requires an accessible render node. Missing devices or codec elements fail session startup; there is no runtime fallback.

`APERTURE_WEBRTC_MEDIA_PRODUCER_CODEC` accepts `auto`, `vp8`, or `h264-va`. The default `auto` selects H.264 VA in resolved hardware mode and VP8 in resolved software mode. Explicit `h264-va` requires hardware, while explicit `vp8` permits GPU rendering with software media encoding.

The per-session `/browser/status` response reports the resolved `gpuMode`, `mediaCodec`, and `renderNode` when hardware is active.

To use a custom config, bind-mount a regular root-owned file at `/etc/aperture/aperture.toml`. The mount helpers intentionally reject untrusted and symlinked config files.

## Runtime

s6-overlay runs as PID 1 and supervises Aperture, Traefik, and the hourly GC trigger. Aperture uses the direct browser supervisor inside the container; systemd remains the default supervisor for non-container installations.

`APERTURE_EXTERNAL_BASE_URL` is required. Other `APERTURE_*` environment variables override values from the packaged config normally.
