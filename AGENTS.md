# AGENTS.md

## Project

- This repository is Aperture, a Nix-packaged Chromium session supervisor.
- Use `nix develop --command ...` for project tooling when the bare command is not available.
- Do not start a frontend dev server.
- Do not stage files unless explicitly asked.
- Do not write new tests unless explicitly asked, but running existing tests/builds is fine.

## Deploy

- Deploy target is `polygon`, not the local machine.
- Do not activate local `aperture.service` / `aperture-traefik.service` as a deployment.
- Build from a source copy that includes untracked files when needed, because Nix flake Git sources can omit untracked files.
- Current proven deploy shape:
  - `nix build <source>#aperture --out-link /tmp/aperture-deploy-result`
  - `nix copy --to ssh://polygon /tmp/aperture-deploy-result`
  - update polygon user units to the new store path:
    - `aperture.service`
    - `browser-session@.service`
    - `aperture-traefik.service`
  - update `/etc/aperture/aperture.toml` paths that point at old Aperture binaries.
  - restart `aperture.service` and `aperture-traefik.service` only.
- Preserve active `browser-session@*.service` units unless explicitly asked to restart them.
- For remote user systemd over ssh, set:
  - `XDG_RUNTIME_DIR=/run/user/$(id -u)`
  - `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`
- Verify deploy on `polygon`:
  - `curl -fsS http://127.0.0.1:28080/api/health`
  - `curl -fsS http://127.0.0.1:28081/api/health`
  - `curl -fsS http://polygon:28081/api/health`

## Runtime Notes

- Main API listens on `127.0.0.1:28080` on `polygon`.
- Traefik listens on `:28081` on `polygon`.
- `browser-session-wrapper` owns session-local lifecycle and wrapper API.
- `webrtc-media-producer` currently remains a child worker; long-term it should be folded into `browser-session-wrapper`, leaving only GStreamer as a child process.
