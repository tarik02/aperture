# AGENTS.md

## Project

- This repository is Aperture, a Nix-packaged Chromium session supervisor.
- Use `nix develop --command ...` for project tooling when the bare command is not available.
- Do not start a frontend dev server.
- Do not stage files unless explicitly asked.
- Do not write new tests unless explicitly asked, but running existing tests/builds is fine.

## Deploy

- Deploy target is `polygon`, not the local machine.
- Use `scripts/deploy-polygon` for normal deployments. The script builds from a temporary source copy that includes untracked files, copies the result to `polygon`, deploys the inactive blue/green API unit, health-checks it, switches the edge, and stops the old API color.
- Do not use plain `nix build .#aperture` as the deployment source when untracked files may matter; Nix flake Git sources can omit them.
- Do not activate local `aperture@*.service`, `aperture.service`, or `aperture-traefik.service` as a deployment.
- The deploy script accepts:
  - `REMOTE_HOST`, default `polygon`
  - `CONFIG_FILE`, default `/etc/aperture/aperture.toml`
  - `OUT_LINK`, default `/tmp/aperture-deploy-result`
  - `HEALTH_TIMEOUT_SECONDS`, default `60`
- The deploy script updates polygon user units and `/etc/aperture/aperture.toml`, restarts only the inactive candidate `aperture@<color>.service`, starts/restarts `aperture-traefik.service` only when needed, then stops the old API color after the edge is healthy.
- Preserve active `browser-session@*.service` units unless explicitly asked to restart them; `scripts/deploy-polygon` updates the template without restarting existing browser sessions.
- For remote user systemd over ssh, set:
  - `XDG_RUNTIME_DIR=/run/user/$(id -u)`
  - `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`
- Verify deploy on `polygon`:
  - `curl -fsS http://127.0.0.1:28081/api/health`
  - `curl -fsS http://polygon:28081/api/health`
  - `curl -fsS https://aperture.tarik02.me/api/health`

## Runtime Notes

- Main API listens on `127.0.0.1:28080` on `polygon`.
- Traefik listens on `:28081` on `polygon`.
- `browser-session-wrapper` owns session-local lifecycle and wrapper API.
- `webrtc-media-producer` currently remains a child worker; long-term it should be folded into `browser-session-wrapper`, leaving only GStreamer as a child process.
