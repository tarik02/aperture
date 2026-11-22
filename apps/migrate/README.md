# aperture-migrate

Moves what an Aperture v1 installation kept into v2. It reads v1 and never writes it; it
writes v2 with the control plane's own code, and a node's store on this machine.

## Before

- **Stop v1.** Its database is read as a file nobody writes: one whose write-ahead log
  still holds something is refused.
- v1's database has to be at v1's last migration (23).
- The v2 control plane's database is reachable, and the node that takes v1's snapshots
  has registered with the control plane once (start its executor; it may keep running).
- Run it on the machine that has v1's files and the node's `APERTURE_DATA_DIR`, as the
  user the executor runs as, with read access to v1's `cold_root` and database.
- Give it the control plane's own environment (`APERTURE_CONTROL_DATABASE_URL`,
  `APERTURE_CONTROL_MASTER_KEY`, `APERTURE_CONTROL_TICKET_KEY`,
  `APERTURE_CONTROL_BOOTSTRAP_TOKEN` or its `_FILE`, and whatever else the control plane
  is given).

## Run

```sh
aperture-migrate plan \
  --v1-database /var/lib/aperture/aperture.db \
  --node node-a --node-store /var/lib/aperture-v2 \
  --tokens reissue --secrets-file ./v1-tokens.jsonl \
  --sessions drop

aperture-migrate apply …the same flags…
```

`plan` prints what would be made, what is left in v1 and why, and what is in the way, and
exits 1 while anything is in the way. It moves nothing. Like the control plane when it
starts, it brings v2's database to v2's schema first.

`apply` does what the plan says, a step at a time. A step is kept together with the record
of it or not at all, so running it again goes on where it stopped, and once everything is
moved it does nothing. The record is the table `moved_from_v1` in v2's database (`kind:v1
id` to the v2 id); drop it once v1 is gone for good.

| Flag | |
| --- | --- |
| `--v1-database` | v1's `database_path` |
| `--v1-cold-root` | v1's `cold_root`; the database's directory without |
| `--node`, `--node-store` | the node that takes the snapshots, by the name it registered with, and its `APERTURE_DATA_DIR` |
| `--tokens reissue\|drop` | see below; without it every live token is in the way |
| `--secrets-file` | where the new tokens' secrets go, a line of JSON each, mode 0600 |
| `--sessions drop` | see below; without it every session v1 still keeps is in the way |

## What becomes of what

| v1 | v2 |
| --- | --- |
| user with an email address | a person's account: same name, address, admin, disabled. No password, passkey or second factor comes along: an admin gives each a setup link. One whose address v2 already has is that account, which stays as it is |
| shared tenant | a workspace with the tenant's id and name; a member whose scopes had `tenant:write` is its admin |
| personal tenant | nothing: what it had is its owner's own |
| snapshot | a snapshot of the workspace (or of the owner, for a personal tenant) on the node named, with its name, description and tags; its id is v1's without dashes. The profile is copied whole, as one layer |
| API token | with `--tokens reissue`, a **new** token with the scopes and snapshots v1's was held to. A shared tenant's are of a service account `<tenant> (from v1)`, an admin of the workspace, which also owns the tenant's snapshots; a system administrator's are of the admin service account `Admin tokens (from v1)` |

Left in v1, and told in the plan: deleted tenants and snapshots, revoked and expired
tokens, passwords, second factors, passkeys, provider identities, invitations, web
sessions, OAuth clients, grants and tokens, session tokens and sharing capabilities,
events and audit events.

**Tokens.** v1 keeps a token as a bcrypt digest of part of it, and v2 finds a token by
the SHA-256 of all of it, so no v1 token works in v2 and none can be made to from what v1
has. Whoever holds one is given a new one from the secrets file.

**Sessions.** This version moves no sessions, nor their files and recordings. Promote a
session worth keeping to a snapshot in v1 before stopping it.

**Storage states.** v1 kept none: one was what its export gave and session creation took.
A file saved from v1's export that names `ancestorOrigins`, `cacheStorage` or `opfs` is
refused by a v2 session; export again from a v2 session created from the migrated
snapshot, which has all of that in its profile.

## Checks

`pnpm test` here runs the mapping's own checks and one end to end: a v1 that
`tests/fixture/record.sh` recorded from a real v1 (run from its image, signed in to a
site) is moved into a control plane on a database of its own and a node from
`target/debug`, and a session created from the migrated snapshot is signed in.
