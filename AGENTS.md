# AGENTS.md

## Project

- This repository is Aperture, a Nix-packaged Chromium session supervisor.
- Use `nix develop --command ...` for project tooling when the bare command is not available.
- Do not start a frontend dev server.
- Do not stage files unless explicitly asked.
- Do not write new tests unless explicitly asked, but running existing tests/builds is fine.
- Real sessions are checked end to end by `e2e/`: `cargo build`, then `pnpm test:e2e` (or `pnpm test tests/<file>` inside `e2e/` for one suite). The checks start the programs in `target/debug` themselves.
