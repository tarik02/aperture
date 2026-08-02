# Docker

The Docker images contain Chromium, the WebRTC media stack, the patched Weston compositor, GStreamer, PipeWire/WirePlumber, bubblewrap, agent-browser, Traefik, and s6-overlay.

Aperture publishes three variants:

| Tag | Architectures | Rendering and media |
| --- | --- | --- |
| `<tag>` | amd64, arm64 | Weston pixman, Chromium SwiftShader, VP8 |
| `<tag>-gpu` | amd64, arm64 | Broad Mesa hardware drivers, H.264 VA or VP8 |
| `<tag>-intel` | amd64 | Intel `crocus` and `iris` drivers without Vulkan, H.264 VA or VP8 |

The base image has no Mesa software rasterizers. Chromium uses its bundled SwiftShader while Weston uses pixman. Hardware images omit llvmpipe, softpipe, and Lavapipe and require a working DRM render node.

Stable and nightly tags are published to GitHub Container Registry. Append `-gpu` or `-intel` to any tag to select a hardware image:

```text
ghcr.io/tarik02/aperture:<version>
ghcr.io/tarik02/aperture:<version>-gpu
ghcr.io/tarik02/aperture:<version>-intel
ghcr.io/tarik02/aperture:latest
ghcr.io/tarik02/aperture:latest-gpu
ghcr.io/tarik02/aperture:latest-intel
ghcr.io/tarik02/aperture:nightly
ghcr.io/tarik02/aperture:nightly-gpu
ghcr.io/tarik02/aperture:nightly-intel
ghcr.io/tarik02/aperture:nightly-<commit>
ghcr.io/tarik02/aperture:nightly-<commit>-gpu
ghcr.io/tarik02/aperture:nightly-<commit>-intel
```

Published images include Aperture's MIT license and OCI source, revision, version, and variant metadata. Each architecture image has an SPDX SBOM and build provenance attestation. Architecture images and published manifests are signed with keyless cosign signatures.

## Build

Build a variant on the target architecture and load it into Docker:

```bash
nix build .#aperture-docker
docker load < result

nix build .#aperture-docker-gpu
docker load < result

# amd64 only
nix build .#aperture-docker-intel
docker load < result
```

The images are tagged with the deploy version or source revision. Hardware image tags include `-gpu` or `-intel`.

## Run

### Software rendering

```bash
export APERTURE_EXTERNAL_BASE_URL=https://aperture.example.com
export APERTURE_IMAGE=aperture:SOURCE_REVISION
export APERTURE_GPU_MODE=software
export APERTURE_WEBRTC_MEDIA_PRODUCER_CODEC=vp8
docker compose -f packaging/docker/compose.yaml up -d
```

The base Compose definition uses Linux host networking so WebRTC advertises the Docker host's reachable LAN addresses instead of container bridge addresses. Traefik listens on TCP port `8080` and WebRTC ICE uses UDP ports `50000-50010` by default. Set `APERTURE_WEBRTC_MEDIA_PRODUCER_UDP_PORT_MIN` and `APERTURE_WEBRTC_MEDIA_PRODUCER_UDP_PORT_MAX` to use a different range. Put TLS or an external ingress in front of port `8080` when the public URL uses HTTPS, and allow or forward the configured UDP range to the host for direct WebRTC connectivity.

On NixOS, allow that range with:

```nix
networking.firewall.allowedUDPPortRanges = [
  {
    from = 50000;
    to = 50010;
  }
];
```

The base Compose definition uses the software image and runs without a GPU. It grants `CAP_SYS_ADMIN` for overlay mounts, allocates 2 GiB of shared memory, persists all state in the `aperture-data` volume, and keeps `/run/aperture` ephemeral. Replacing the container may terminate active browser sessions; the Docker deployment does not provide blue/green rollout semantics.

### GPU rendering and encoding

Select a DRM render node and add the GPU override:

```bash
export APERTURE_EXTERNAL_BASE_URL=https://aperture.example.com
export APERTURE_GPU_IMAGE=ghcr.io/tarik02/aperture:nightly-gpu
export APERTURE_RENDER_NODE=/dev/dri/renderD128
export APERTURE_GPU_MODE=hardware
export APERTURE_WEBRTC_MEDIA_PRODUCER_CODEC=h264-va
test -c "$APERTURE_RENDER_NODE"
docker compose \
  -f packaging/docker/compose.yaml \
  -f packaging/docker/compose.gpu.yaml \
  up -d
```

The override maps one render node instead of the `/dev/dri` directory. Docker Engine and Podman both accept this form. Set `APERTURE_RENDER_NODE` when the host uses another node. The container adds the `aperture` user to the group owning the supplied device.

Use an `-intel` tag instead when the host is amd64 with an Intel GPU and does not need broader Mesa support. The `-gpu` image contains broad Mesa drivers and, on amd64, Intel media drivers. The `-intel` image keeps only the Intel GL and VA drivers needed by Aperture.

Rootless Podman must also preserve the host user's supplementary device groups. The host user must belong to the group that owns the render node.

```bash
podman compose \
  -f packaging/docker/compose.yaml \
  -f packaging/docker/compose.gpu.yaml \
  -f packaging/docker/compose.podman-gpu.yaml \
  up -d
```

Do not set `APERTURE_GPU_MODE=hardware` without the required GPU overrides. The control-plane health check can pass while every session fails with a missing or inaccessible `/dev/dri/renderD*` device.

The image variant selects the GPU mode:

- The base image pins software mode and does not need `/dev/dri`.
- `-gpu` and `-intel` pin hardware mode. A missing render node or codec element fails session startup; use the base image when hardware is unavailable.

`APERTURE_WEBRTC_MEDIA_PRODUCER_CODEC` accepts `auto`, `vp8`, or `h264-va`. The default `auto` selects H.264 VA in resolved hardware mode and VP8 in resolved software mode. Explicit `h264-va` requires hardware, while explicit `vp8` permits GPU rendering with software media encoding.

The per-session `/browser/status` response reports the resolved `gpuMode`, `mediaCodec`, and `renderNode` when hardware is active.

### Non-default host ports

Host networking means two Aperture deployments cannot both bind the default Traefik and API ports. To run another container on `18080` and `38080`, create a Traefik static config:

```yaml
# traefik-docker.yaml
entryPoints:
  web:
    address: ":18080"

providers:
  file:
    directory: "/run/aperture/traefik/dynamic"
    watch: true

api:
  dashboard: false
  insecure: false
```

Add a Compose override next to it:

```yaml
# compose.ports.yaml
services:
  aperture:
    environment:
      APERTURE_LISTEN_ADDRESS: 127.0.0.1:38080
      APERTURE_DEPLOY_BLUE_URL: http://127.0.0.1:38080
      APERTURE_DEPLOY_GREEN_URL: http://127.0.0.1:38080
    volumes:
      - ./traefik-docker.yaml:/etc/aperture/traefik.yaml:ro
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:18080/api/health"]
```

Start it with both definitions. Add the GPU files after `compose.ports.yaml` when hardware access is required.

```bash
docker compose \
  --project-directory . \
  -f packaging/docker/compose.yaml \
  -f compose.ports.yaml \
  up -d
```

Point the external HTTP proxy at port `18080`. Preserve the original `Host`, `X-Forwarded-Proto`, and WebSocket upgrade headers. The public base URL must match `APERTURE_EXTERNAL_BASE_URL`.

### Bootstrap and verify a session

A new data volume has no API tokens. Bootstrap it once and store the printed system-admin token:

```bash
docker compose -f packaging/docker/compose.yaml exec aperture \
  aperture --config /etc/aperture/aperture.toml admin bootstrap
```

Create a tenant and copy its `tenant id` from the output:

```bash
docker compose -f packaging/docker/compose.yaml exec aperture \
  aperture --config /etc/aperture/aperture.toml admin tenants create \
  --display-name docker
```

Check both container health and an actual browser session. A green `/api/health` response only proves that the control plane is running.

```bash
export APERTURE_BASE_URL=http://127.0.0.1:8080
export APERTURE_TENANT_ID=TENANT_ID
read -rsp "bootstrap token: " APERTURE_TOKEN
export APERTURE_TOKEN

curl -fsS "$APERTURE_BASE_URL/api/health" | jq
curl -fsS \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $APERTURE_TENANT_ID" \
  "$APERTURE_BASE_URL/api/browser/channels" | jq

session_response="$(curl -fsS -X POST \
  -H "Authorization: Bearer $APERTURE_TOKEN" \
  -H "X-Aperture-Tenant-Id: $APERTURE_TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"browser":{"channel":"chromium","args":[]}}' \
  "$APERTURE_BASE_URL/api/sessions")"
session_id="$(jq -er '.session | select(.status == "running") | .id' \
  <<<"$session_response")"
session_token="$(jq -er '.sessionToken' <<<"$session_response")"

curl -fsS \
  -H "Authorization: Bearer $session_token" \
  "$APERTURE_BASE_URL/sessions/$session_id/browser/status" | jq
```

On GPU deployments, `browser/status` must report `gpuMode` as `hardware`, the selected `renderNode`, and at least one ready target. If session creation fails or the status has no ready target, inspect the supervised runtime logs:

```bash
docker compose -f packaging/docker/compose.yaml logs --tail=200 aperture
```

To use a custom config, bind-mount a regular root-owned file at `/etc/aperture/aperture.toml`. The mount helpers intentionally reject untrusted and symlinked config files.

## Runtime

s6-overlay runs as PID 1 and supervises Aperture, Traefik, and the hourly GC trigger. Aperture uses the direct browser supervisor inside the container; systemd remains the default supervisor for non-container installations.

`APERTURE_EXTERNAL_BASE_URL` is required. Other `APERTURE_*` environment variables override values from the packaged config normally.
