# Releasing

Everything has one version: the programs, the session's image, the Nix packages and every npm package move together, because the client packages speak the server's protocol. [release-please](https://github.com/googleapis/release-please) keeps it, from the titles of squash-merged pull requests, which `pr-title.yml` holds to conventional commits.

The version is written in `Cargo.toml` (`[workspace.package]`), in `Cargo.lock` for the workspace's crates, and in each `package.json` under `packages/` and `apps/`. Nothing else writes one: the flake reads `Cargo.toml`, the programs read their crate's version, and the control plane, its API and the migrator read their `package.json`. Between releases the tree has the version of the last release.

## What a release is

| What | Where |
|---|---|
| The session's image, for `linux/amd64` and `linux/arm64`, signed, with provenance and an SBOM | `ghcr.io/tarik02/aperture-session:<version>`, and `:beta` or `:latest` |
| The npm packages `control-api`, `executor-client`, `session-client`, `session-react`, `session-element` of `@aperture-browser`, with provenance | npm, under the dist-tag `beta` or `latest` |
| The control plane's image and the node's, for the same two, signed: what `deploy/compose.yaml` puts together | `ghcr.io/tarik02/aperture-control` and `ghcr.io/tarik02/aperture-node`, with the same tags |
| The session's image as files for `docker load`, their SBOMs, and `SHA256SUMS` | the GitHub release |
| The programs, the control plane and the migrator as Nix builds them | the `aperture-browser` Cachix cache |
| The changes | `CHANGELOG.md` and the GitHub release |

The programs are not release files of their own: they run a browser, a sandbox and encoders that the flake wires to them, so they are installed from the flake (`github:tarik02/aperture/v<version>`), by its NixOS modules, or as the image. The migrator is `nix run github:tarik02/aperture/v<version>#aperture-migrate`.

A prerelease moves the tag it is named as, `beta` for `1.0.0-beta.2`, on the registry and on npm. `latest` is moved by a stable release alone.

## Cutting a beta

1. Merge pull requests into `master` as usual. `feat:` and `fix:` titles are what the changelog is made of.
2. `release-please.yml` keeps one pull request open, `chore(master): release 1.0.0-beta.N`, with the changelog and every version bumped. `checks.yml` and `e2e.yml` run on it.
3. Merge that pull request when it is green. release-please tags `v1.0.0-beta.N` and makes the GitHub release, as a prerelease.
4. The same run of `release-please.yml` then runs `e2e.yml` once more on the tagged commit, and only after it `publish.yml`: the images, the files of the release, and last `npm.yml` at the tag.

When something fails after the tag is made, fix what failed and run the failed jobs of that run again; each step can be run twice. `npm.yml` alone is started again with `gh workflow run npm.yml --ref v1.0.0-beta.N`; it leaves out what is already on npm.

The first release is `1.0.0-beta.1` (`initial-version` in `.github/release-please-config.json`). Whatever its commits are, a release after `1.0.0-beta.N` is `1.0.0-beta.N+1`.

## Cutting a stable release

1. In `.github/release-please-config.json`, set `"prerelease": false`. Merge that as `chore: …`.
2. The release pull request is now `chore(master): release 1.0.0`. Merge it.

With `"prerelease": false` left as it is, later releases are `1.0.1`, `1.1.0` and `2.0.0` by what their commits are. For betas of a later version, set `"prerelease": true` again and name the first of them in a commit's body, `Release-As: 1.1.0-beta.1`; those after it count up by themselves.

Any version can be forced the same way, with `Release-As: x.y.z` in the body of a commit on `master`.

## Nightlies

Every push to `master` that is not a release's commit is published by `nightly.yml` as `v0.0.0-nightly.<run>.<sha>`: a GitHub prerelease, the image as `:nightly` and `:nightly-<sha>`, and the npm packages under the dist-tag `nightly`. A nightly has no files on its release. The tree is not bumped for it; `.github/scripts/set-version.sh` writes the version into the checkout it is built from.

## What is checked

- `checks.yml`, on every pull request and on pushes to `master`: formatting, lint, types, the builds, the Rust checks, the generated code, and `nix packages`, which builds what the flake installs and fetches the pnpm dependencies again, so that a `workspacePnpmDeps` hash left behind by a change of `pnpm-lock.yaml` fails. What it builds goes to the Cachix cache, so the next run builds only what changed; `session image` and `deployment images` then start the images as their users do.
- `e2e.yml`, on pushes to `master`, on a release's pull request, on a pull request labelled `e2e`, and before anything of a release is published: real sessions end to end, and the NixOS modules on a virtual machine (`nix/tests`).

## What the workflows need

Set once, in the repository's settings:

| Name | Kind | For |
|---|---|---|
| `APP_ID` | variable | The GitHub App release-please acts as. A pull request opened with `GITHUB_TOKEN` starts no workflows, so the release's would have no checks |
| `APP_PRIVATE_KEY` | secret | That App's private key. The App needs read and write access to contents and pull requests |
| `CACHIX_AUTH_TOKEN` | secret | Pushing a release's programs to the `aperture-browser` cache. Without it a release is published and nothing is pushed |

The registry needs no secret: the image is pushed with `GITHUB_TOKEN`. After the first push, make the package `aperture-session` public in its settings.

npm needs no secret either. Each of the five packages has a trusted publisher on npmjs.com: repository `tarik02/aperture`, workflow `npm.yml`, no environment. A package has to exist before it can have one, so a new name is published once by hand as `0.0.0-init.0` under the dist-tag `init`, as the others were. npm keeps a trusted publisher that has published nothing for two days, "pending validation", and drops it then: add one within two days of the release that first uses it.

The first release leaves out what was on `master` before this rewrite by `bootstrap-sha` in `.github/release-please-config.json`, which is the last commit of before it. It is read for the first release only.
