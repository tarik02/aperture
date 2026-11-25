# aperture-migrate

Moves what an Aperture v1 installation kept into v2. It reads v1 and never writes it; it
writes v2 with the control plane's own code, and a node's store on this machine.

## Before

- **Stop v1, and its sessions.** Its database is read as a file nobody writes: one whose
  write-ahead log still holds something is refused. v1's browsers run on after its server
  stops; a session whose profile is still mounted is in the way until it is not.
- v1's database has to be at v1's last migration (23).
- The v2 control plane's database is reachable, and the node that takes v1's snapshots and
  sessions has registered with the control plane once (start its executor; it may keep
  running).
- Run it on the machine that has v1's files and the node's `APERTURE_DATA_DIR`, as the
  user the executor runs as, with read access to v1's `store_root`, `cold_root` and
  database.
- Give it the control plane's own environment (`APERTURE_CONTROL_DATABASE_URL`,
  `APERTURE_CONTROL_MASTER_KEY`, `APERTURE_CONTROL_TICKET_KEY`,
  `APERTURE_CONTROL_BOOTSTRAP_TOKEN` or its `_FILE`, and whatever else the control plane
  is given).

## Run

```sh
aperture-migrate plan \
  --v1-database /var/lib/aperture/aperture.db \
  --node node-a --node-store /var/lib/aperture-v2

aperture-migrate apply …the same flags…
```

`plan` prints what would be made, what is left in v1 and why, what is moved and is not
quite what it was, and what is in the way, and exits 1 while anything is in the way. It
moves nothing. Like the control plane when it starts, it brings v2's database to v2's
schema first.

`apply` does what the plan says, a step at a time, each whole or not at all.

| Flag | |
| --- | --- |
| `--v1-database` | v1's `database_path` |
| `--v1-cold-root` | v1's `cold_root`, where its snapshots and its sessions' files are; the database's directory without |
| `--v1-store-root` | v1's `store_root`, where its sessions' profiles are; the cold root without |
| `--node`, `--node-store` | the node that takes the snapshots and sessions, by the name it registered with, and its `APERTURE_DATA_DIR` |
| `--tokens keep\|reissue\|drop` | see below; `keep` without it |
| `--secrets-file` | with `--tokens reissue`, where the new tokens' secrets go, a line of JSON each, mode 0600 |
| `--sessions drop` | leaves v1's sessions behind, with their files and recordings; without it they are moved |

## Ids

Everything keeps the id v1 gave it, and is as old in v2 as it was in v1. A person, a
workspace and a token have v1's UUID as it is. A snapshot and a session have it without
its dashes, which is how v2's nodes write ids and so how both are known everywhere in v2.

That is all that tells what was moved: `apply` makes what v2 lacks under an id of v1's
and leaves what it has, so running it again goes on where it stopped, and once everything
is moved it does nothing. It keeps no record of its own, and nothing of it stays in v2's
database. Two things follow. Something v2 has under an id of v1's that was made at
another moment is something else, and in the way. And something that was moved and then
deleted in v2 is moved again by a later `apply`: run it until it has nothing to do, and
then no more.

## What becomes of what

| v1 | v2 |
| --- | --- |
| user with an email address | a person's account: same id, name, address, admin, disabled, with their password and their authenticator. See below. No passkey comes along, nor a recovery code; one who had no password is given a setup link by an admin. One whose address v2 already has is that account, which stays as it is, id and all, and signs in as it does |
| shared tenant | a workspace with the tenant's id and name; a member whose scopes had `tenant:write` is its admin, and a system administrator, who acted in every shared tenant without being a member, is an admin of each |
| personal tenant | nothing: what it had is its owner's own |
| snapshot | a snapshot on the node named, with its name, description and tags. A shared tenant's is the workspace's, and names no account as its maker: v1 says of none who made it. A personal tenant's is its owner's own. The profile is copied whole, as one layer |
| session that is suspended, or failed with its profile kept | a suspended session on the node named, with its label and tags, the workspace's or its owner's own as a snapshot is. See below |
| session that was running when v1 stopped | the same, as its browser left it |
| session's routing | the session's routing: upstreams and rules are written alike in both. A rule whose match names an IPv6 address is left out and told in the plan |
| session's files, recordings among them | the session's files, under the same paths |
| API token | a token with v1's id, its scopes and the sessions and snapshots it was held to: the same token with `--tokens keep`, a **new** one with `--tokens reissue`. See below for whose it is |

Left in v1, and told in the plan: deleted tenants, snapshots and sessions, sessions v1
never finished creating, revoked and expired tokens, recovery codes, passkeys, provider
identities, invitations, web sessions, OAuth clients, grants and tokens, session tokens
and sharing capabilities (v2 lets into a session by tickets and share links), events and
audit events.

**Passwords, second factors and tokens.** v1 keeps a token as a bcrypt digest of what
follows its id, and v2 finds a token by the SHA-256 of all of it; v1 keeps a password as
Argon2id, and v2 as scrypt. So with `--tokens keep` a token is written as v2's with v1's
digest beside it, in the control plane's table `v1_api_tokens`, and a password as v1's
digest. The control plane checks each as v1 did the first time it is used, and from then
on keeps it as its own (`apps/control/src/v1-credentials/`). An authenticator's secret,
which v1 kept as it is, is sealed as v2 seals one and needs nothing more; v1's recovery
codes, of which it kept only a SHA-256, cannot come along. This is for a while: a later
beta removes what reads v1's digests, after which a token or a password nobody used is
none. The control plane logs at every start how many are left;
[Upgrading from v1](../../docs/upgrading-from-v1.md#v1s-credentials-kept-for-a-while)
says what to do before then. With `--tokens reissue`, whoever holds a token is given a
new one from the secrets file instead.

A token of v2 is always some account's. A shared tenant's were nobody's, so a service
account bears them: `<tenant> tokens (from v1)`, a member of the workspace, and its admin
where one of the tokens had `tenant:write`. It is made only for a tenant that has tokens
to move, has the tenant's id, and is of nothing else: the tenant's snapshots and
sessions are the workspace's. A system administrator's tokens are of the admin service
account `Admin tokens (from v1)`, whose id is made of v1's installation id; v1 kept such a
token out of everyone's personal tenant, and an admin's token of v2 reaches what is each
person's own as well, which the plan says. A personal
tenant's are its owner's own, and reach what their owner reaches: the workspaces they are
in as well, which the plan says of each such token, since v2 holds no token to what is
its account's own.

**Sessions.** A session's profile in v1 is what its browser wrote, kept by overlayfs
above the profile of the snapshot it was created from. A v2 node keeps a suspended
session the same way, above a layer, and reads it with the same overlayfs options. So
the directory is copied as it is, with the devices that say a file of the snapshot is
gone and the attributes that say a directory hides the snapshot's, into
`sessions/<id>/upper` of the node's store, beside a `session.json` that names the layer
of the moved snapshot. A session on a snapshot v1 deleted and still kept for it gets that
snapshot's profile as a layer of its own, and names no snapshot. Resumed, it has its
cookies and storage and opens the pages it had; what a page held in memory is gone, as
after any suspension.

A session that was running when v1 stopped has no clean end: its browser was stopped by
whatever stopped the machine or the unit. What it had written is on disk and is moved,
and the browser brings its pages back as after a crash; what it had not written yet, a
cookie of the last half minute, is lost. It is moved only once its profile is unmounted.

What v2's routing cannot say of v1's: a match that names an IPv6 address. What it says
differently: a connection that goes `direct` to a private or local address is refused by
a v2 node unless the node allows it (`APERTURE_EGRESS_ALLOW`).

A recording of v1 is a finished video among the session's files, `recordings/….webm` or
`.mp4`, with the timeline v1 made of it. It is moved as that, and read as any file of the
session. It is not among what v2 lists as the session's recordings: those have a journal
and an edit of v2's own, which v1 never wrote. Recordings v1 had not ended are left.

**Storage states.** v1 kept none: one was what its export gave and session creation took.
A file saved from v1's export that names `ancestorOrigins`, `cacheStorage` or `opfs` is
refused by a v2 session; export again from a v2 session created from the migrated
snapshot, which has all of that in its profile.

## Checks

`pnpm test` here runs the mapping's own checks and two end to end. The first moves a v1
that `tests/fixture/record.sh` recorded from a real v1 (run from its image, signed in to a
site, with a suspended session that has a file, a recording and routing, one of a
personal tenant, and one left running above a snapshot) into a control plane on a
database of its own and a node from `target/debug`, with its tokens made anew. A session
created from the migrated snapshot is signed in, and the migrated sessions resume signed
in, with their pages and files. The second moves the same v1 with its tokens kept, given
passwords, a second factor and a token whose secret is known, made by v1's own libraries,
and signs in and calls with them.
