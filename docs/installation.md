# Aperture installation

Aperture is packaged with Nix and runs as a per-user desktop service on NixOS (or any Linux host with user systemd).

## Build and install

From the repository:

```bash
nix build .#aperture
./result/bin/aperture --help
```

Install into your user profile:

```bash
nix profile install .#aperture
```

The package provides:

- `aperture` — main supervisor CLI and HTTP API
- `aperture-mount-session` / `aperture-unmount-session` — privileged overlay helpers (sudo)
- `browser-session-wrapper` — bwrap Chromium launcher used by user systemd units
- systemd user units under `$out/share/systemd/user/` (Nix fixup may also link `$out/lib/systemd/user/`)
- Traefik static config template under `$out/share/aperture/traefik/`
- sudoers snippet under `$out/share/aperture/sudoers/`

## Configuration

Create `~/.config/aperture/aperture.yaml` (or set `APERTURE_*` environment variables). Required values include:

- `store_root`, `runtime_root` — persistent and runtime state directories
- `external_base_url` — public URL Traefik serves (for generated connection and signed-file links)
- MCP settings — enabled by default; see the example below
- `channels` — browser channel registry (`executable` paths only; API accepts channel names)

Example:

```yaml
store_root: /home/USER/.local/state/aperture
runtime_root: /run/user/UID/aperture
external_base_url: https://browser.example.test
listen_address: 127.0.0.1:8080
mcp_enabled: true
agent_browser_tools_default: core,tabs,mobile,network
agent_browser_idle_timeout: 5m
tool_output_max_bytes: 16777216
signed_file_url_ttl: 15m
signed_file_url_max_ttl: 24h

channels:
  chromium:
    executable: /run/current-system/sw/bin/chromium
    default_args: []
```

The central Streamable HTTP MCP endpoint is `/mcp`; the per-session endpoint is `/sessions/:sessionId/mcp`. Central MCP requires an Aperture API bearer token. Per-session MCP accepts an authorized API bearer token or the session-bound `sessionToken`. A session token authorizes that session's routed live endpoints, including CDP, WebRTC, and per-session MCP; it does not authorize `/api/*` or central MCP.

On first `aperture serve`, the database is migrated and a local job token is created at `$runtime_root/job-token` (mode `0600`). The GC timer uses `aperture trigger gc`, which reads that token and calls `POST /internal/jobs/gc` on the loopback listener.

## User systemd services

Copy or link units from the package into `~/.config/systemd/user/` (the NixOS/Home Manager module does this automatically). Enable the core services:

```bash
systemctl --user daemon-reload
systemctl --user enable --now aperture.service
systemctl --user enable --now aperture-gc.timer
systemctl --user enable --now aperture-traefik.service
```

`browser-session@.service` is started by Aperture per session; do not enable it directly.

Prepare Traefik runtime config before starting `aperture-traefik.service`:

```bash
mkdir -p "$XDG_RUNTIME_DIR/aperture/traefik"
cp "$(dirname "$(which aperture)")/../share/aperture/traefik/static.yaml.template" \
  "$XDG_RUNTIME_DIR/aperture/traefik/static.yaml"
# Edit static.yaml: set entrypoints, certificates, and dynamic config watch path to
# $XDG_RUNTIME_DIR/aperture/traefik/dynamic.yaml (written by Aperture).
```

## Sudo helpers

Install the sudoers fragment as root (path from the package output):

```bash
sudo install -m 0440 share/aperture/sudoers/aperture-mount-helpers /etc/sudoers.d/aperture-mount-helpers
```

Edit the file to substitute your login user for `%aperture_user%` and the store-path helper binaries for `@mountSessionHelper@` / `@unmountSessionHelper@`.

## Bootstrap and operation

```bash
aperture migrate
aperture admin bootstrap
# Use the printed system-admin token for /admin/* and tenant setup.
```

Garbage collection is not scheduled inside `aperture serve`; enable `aperture-gc.timer` or run `aperture trigger gc` manually.

## NixOS module

The flake exposes `nixosModules.aperture` at the flake root (not per-system). It wires a **partial** desktop integration for a single login user:

- installs the package
- writes `/etc/aperture/aperture.toml` with store/runtime paths and a Chromium channel (same path trusted by sudo mount helpers)
- enables user systemd units: `aperture.service`, `aperture-gc.timer`, and `browser-session@.service`
- grants `${user}` passwordless sudo for the packaged mount/unmount helpers

Traefik, TLS, and edge networking remain manual. Import the module and set the required options:

```nix
imports = [ inputs.aperture.nixosModules.aperture ];
services.aperture = {
  enable = true;
  user = "alice";
  externalBaseUrl = "https://browser.example.test";
};
```

## Verification

```bash
nix flake check
```

Live desktop smoke tests exercise the real `app.Serve` path, user systemd browser units, sudo-backed overlay mounts, and direct loopback CDP. They are gated behind `APERTURE_LIVE_E2E=1` and do not start Traefik. Traefik/CDP edge routing is covered separately by `APERTURE_LIVE_TRAEFIK=1` in `internal/traefik/live_test.go`.
