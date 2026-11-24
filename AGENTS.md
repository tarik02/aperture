# AGENTS.md

## Project

- This repository is Aperture, a Nix-packaged Chromium session supervisor.
- Use `nix develop --command ...` for project tooling when the bare command is not available.
- Do not start a frontend dev server.
- Do not stage files unless explicitly asked.
- Do not write new tests unless explicitly asked, but running existing tests/builds is fine.
- Real sessions are checked end to end by `e2e/`: `cargo build`, then `pnpm test:e2e` (or `pnpm test tests/<file>` inside `e2e/` for one suite). The checks start the programs in `target/debug` themselves.
- Of a check that fails, in `e2e/` or `apps/control`, what its programs logged last and what its pages showed is kept below `test-failures/` (`APERTURE_E2E_FAILURES` names another directory). Two files' checks run at once; `APERTURE_E2E_WORKERS` says how many on a machine that carries more.
- A check presses what a page shows with `page.click`, `page.tap` or `clickElement`, which wait until it is there, at rest and under nothing else. A press that needs a retry or a sleep before it is taken is a fault to find, in the check or in what it presses.
