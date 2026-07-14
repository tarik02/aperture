# Docker

The Docker image contains the complete Aperture runtime: Chromium, the WebRTC media stack, the patched Weston compositor, GStreamer, PipeWire/WirePlumber, bubblewrap, Traefik, and s6-overlay. It is available for Linux amd64 and arm64.

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

The container exposes Traefik on port `8080`. Put TLS or an external ingress in front of that port when the public URL uses HTTPS.

The Compose definition grants `CAP_SYS_ADMIN` for overlay mounts, allocates 2 GiB of shared memory, persists all state in the `aperture-data` volume, and keeps `/run/aperture` ephemeral. Replacing the container may terminate active browser sessions; the Docker deployment does not provide blue/green rollout semantics.

The default media codec is software VP8. For VA-API H.264, pass `/dev/dri` into the container and set:

```bash
APERTURE_WEBRTC_MEDIA_PRODUCER_CODEC=h264-va
```

To use a custom config, bind-mount a regular root-owned file at `/etc/aperture/aperture.toml`. The mount helpers intentionally reject untrusted and symlinked config files.

## Runtime

s6-overlay runs as PID 1 and supervises Aperture, Traefik, and the hourly GC trigger. Aperture uses the direct browser supervisor inside the container; systemd remains the default supervisor for non-container installations.

`APERTURE_EXTERNAL_BASE_URL` is required. Other `APERTURE_*` environment variables override values from the packaged config normally.
