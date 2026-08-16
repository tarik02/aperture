# Development

Use the default development shell for project tooling:

```bash
nix develop
```

The shell provides Go, pnpm, Chromium, GStreamer, Weston, and the code-quality tools. It does not start Aperture or change host configuration.

## Run the complete stack

Run the Nix-built software-rendering image with rootless Podman:

```bash
nix run .#dev
```

The command builds and loads the image, then runs it in the foreground at `http://127.0.0.1:8080`. The container includes the patched Weston compositor, Aperture shell, Chromium, PipeWire, GStreamer, bubblewrap, overlay helpers, Traefik, and s6. State persists in `.data/store` under the current directory.

The runner uses pasta networking. It binds the selected public HTTP port and WebRTC UDP ports `50000-50010` to `127.0.0.1`. Internal API and session ports stay inside the container. The runner fixes the WebRTC port range and advertised address to match these mappings.

The runner provisions a `default` tenant and writes the full-access system-admin token to `.data/admin-token` on the first run. Later runs preserve both. Git ignores `.data`, and the runner creates the directory with mode `0700` and the token with mode `0600`.

Load the token into your shell with:

```bash
export APERTURE_TOKEN=$(<.data/admin-token)
```

Stop the container with `Ctrl-C`.

### Custom port and settings

Choose another public port with `--port`:

```bash
nix run .#dev -- --port 18080
```

Pass Aperture environment overrides with a Podman environment file:

```bash
nix run .#dev -- --env-file ./dev.env
```

For example:

```dotenv
APERTURE_LOG_LEVEL=debug
APERTURE_WEBRTC_MEDIA_PRODUCER_CODEC=vp8
APERTURE_WEBRTC_COMPOSITOR_WIDTH=1920
APERTURE_WEBRTC_COMPOSITOR_HEIGHT=1080
```

The runner sets `APERTURE_EXTERNAL_BASE_URL` to the selected loopback port. Use the environment file for other Aperture settings.

Mount a complete configuration file when environment overrides are insufficient:

```bash
nix run .#dev -- --config ./aperture.dev.toml
```

The file must be readable by the container user and must not be group or world writable. Put secrets in the environment file rather than a world-readable TOML file.

### GPU runtime

Use the broad-driver image and select a DRM render node:

```bash
nix run .#dev-gpu -- --render-node /dev/dri/renderD128
```

The render node defaults to `/dev/dri/renderD128`. The host user must belong to the group that owns the device. The runner preserves supplementary groups inside rootless Podman and enables hardware GPU mode with Weston's GL renderer.

Intel and AMD render nodes use the drivers bundled in the GPU image. NVIDIA uses the host driver through CDI. On NixOS, enable it before running `dev-gpu`:

```nix
hardware.nvidia-container-toolkit.enable = true;
```

The runner detects an NVIDIA render node and requests its matching CDI GPU device. Codec `auto` falls back to VP8 because NVIDIA does not expose the VA-API encoder used by `h264-va`.

Use `nix run .#dev -- --help` or `nix run .#dev-gpu -- --help` for the complete option list.
