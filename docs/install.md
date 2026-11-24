# Install

There are three supported ways to run Aperture:

| | What you get | Use it for |
|---|---|---|
| [NixOS modules](#nixos) | The whole deployment: control plane, console, proxy, nodes | Anything with accounts, more than one session, or more than one machine |
| [Docker Compose](#docker-compose) | The same on one machine, in containers | A deployment with accounts where there is no NixOS |
| [Container image](#container-image) | One session, served on its own | A single browser for one operator, with no control plane |

The control plane and the node are also the flake's packages (`aperture`, `aperture-control`) on any Linux with Nix, where you write the units yourself from [Configuration](configuration.md).

`<version>` below is a release, such as `1.0.0-beta.1`. Releases are the tags `v<version>` of `github:tarik02/aperture`.

## Prerequisites

- **Linux, `x86_64` or `aarch64`.** Those are the systems the flake builds for.
- **Unprivileged user namespaces, and overlayfs inside them.** A session's browser runs in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox that the node's unprivileged user makes, with the profile mounted as an overlay. That takes Linux 5.11 or newer and a kernel that does not forbid user namespaces to unprivileged users.
- **PostgreSQL** for the control plane. The module runs one on the same machine unless told otherwise. The control plane brings the database to its schema when it starts.
- **Memory.** Each session is a Chromium. The VM the modules are checked on has 4 GB and 4 cores for one session.
- **Graphics drivers are optional.** A session draws its pages with the machine's GPU where it has one and in software where it has none.
- **Object storage is optional.** Without it, snapshots and suspended sessions stay on the node that has them. See [A second node](#a-second-node).

Released builds are in the `aperture-browser` Cachix cache (`cachix use aperture-browser`); without it Nix builds everything from source.

## NixOS

The flake has one module for each part and one that puts them all on a machine:

| Module | What it sets up | Options below |
|---|---|---|
| `nixosModules.keys` | Makes the secrets the parts share, once, on the machine | `services.aperture.keys` |
| `nixosModules.control` | The control plane, its console and, by default, its PostgreSQL | `services.aperture.control` |
| `nixosModules.proxy` | Traefik before the control plane and the nodes | `services.aperture.proxy` |
| `nixosModules.node` | An executor that runs sessions and registers with a control plane | `services.aperture.node` |
| `nixosModules.standalone` (also `default`) | All four, enabled by `services.aperture.standalone.enable` | |

### One machine

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.aperture.url = "github:tarik02/aperture/v<version>";

  outputs =
    { nixpkgs, aperture, ... }:
    {
      nixosConfigurations.aperture = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          ./hardware-configuration.nix
          aperture.nixosModules.default
          {
            services.aperture.standalone.enable = true;
            services.aperture.control.publicUrl = "https://aperture.example.com";
          }
        ];
      };
    };
}
```

That is the deployment `nix/tests/deployment.nix` checks on a virtual machine. After a rebuild the machine runs four units:

| Unit | Listens on | What it is |
|---|---|---|
| `aperture-keys.service` | | Makes the secrets in `/var/lib/aperture-keys`, once |
| `aperture-control.service` | `127.0.0.1:7800` | The control plane and the console |
| `aperture-node.service` | `127.0.0.1:7900` | The executor |
| `aperture-proxy.service` | `:80` | Traefik: the one address people and agents use |

Nothing is open in the firewall until you say so (`services.aperture.proxy.openFirewall`), and the proxy speaks plain HTTP: see [TLS](#tls) before letting anyone in.

Leave `publicUrl` out while trying things on `http://localhost`; set it before real use. Signing in takes requests from pages of that origin alone, and passkeys are good at that address and nowhere else.

### Keys and tokens

`services.aperture.keys` writes these into `/var/lib/aperture-keys`, each readable by the part that needs it. What is there stays: a file is made only when it is missing.

| File | What it is | Who reads it |
|---|---|---|
| `master.key` | The master key. What the control plane has to read again, such as a node's operator token, is sealed with it. It must stay the same | control plane |
| `ticket.pem` | The Ed25519 private key tickets are signed with (PKCS#8, PEM) | control plane |
| `ticket.pub.pem` | Its public key, with which nodes check tickets | every node |
| `bootstrap-token` | Does what an admin does, before there is any account | control plane, and you |
| `registration-token` | Lets a node register without an admin making a token first | control plane, nodes |
| `proxy-token` | Lets the proxy read its routes, and nothing else | control plane |
| `proxy.env` | The same token as Traefik takes it from its environment | proxy |

Where secrets reach machines some other way (sops-nix, agenix), leave `services.aperture.keys` off and give each part its files: `masterKeyFile`, `ticketKeyFile`, `bootstrapTokenFile`, `proxyTokenFile`, `registrationTokenFile` of `services.aperture.control`, `registrationTokenFile` and `ticketKeyFile` of `services.aperture.node`, and `tokenEnvironmentFile` of `services.aperture.proxy`. Made by hand, they are:

```sh
openssl rand -base64 32 > master.key           # at least 32 bytes; the same for bootstrap-token,
                                               # registration-token and proxy-token
openssl genpkey -algorithm ed25519 -out ticket.pem
openssl pkey -in ticket.pem -pubout -out ticket.pub.pem
printf 'TRAEFIK_PROVIDERS_HTTP_HEADERS_AUTHORIZATION=Bearer %s\n' "$(cat proxy-token)" > proxy.env
```

### First sign-in

Nobody makes themselves a person: an admin does. The first admin is made from a link the control plane logs when it starts, for as long as nobody signs in yet:

```sh
journalctl --unit aperture-control --grep 'Setup link'
# Setup link: https://aperture.example.com/setup#token=…
```

Open the link, say your name, email address and a password, and you are signed in to the console as an admin. From there everything else is in the console: people, service accounts, API tokens, workspaces, nodes, registration tokens, sign-in providers.

The link starts with `publicUrl`. Without one it names the address the control plane listens on, `http://127.0.0.1:7800`, which opens on the machine itself; from elsewhere, put the address you reach Aperture at in its place and keep `/setup#token=…`.

It is good once. As soon as anyone is a person here it makes nobody, whoever has it, and no later start logs it; nor does it come back when every person is deleted, as a deleted account is kept. Until then every start logs the same link: the token is made of the master key and kept nowhere. Whoever reads the control plane's log before the first admin is made can become it, so make it soon.

#### With the bootstrap token

For what sets a deployment up without anyone at a browser, the bootstrap token does what an admin does, the first admin included:

```sh
export APERTURE_URL=https://aperture.example.com    # or http://localhost on the machine itself
BOOTSTRAP=$(sudo cat /var/lib/aperture-keys/bootstrap-token)
api() { curl -fsS -H "Authorization: Bearer $BOOTSTRAP" -H 'Content-Type: application/json' "$@"; }

ID=$(api -X POST "$APERTURE_URL/api/control/accounts" \
  -d '{"name":"Ada","email":"ada@example.com","admin":true}' | jq -r .id)
TOKEN=$(api -X POST "$APERTURE_URL/api/control/accounts/$ID/setup-token" | jq -r .token)
echo "$APERTURE_URL/invite#token=$TOKEN"
```

Whoever opens the link that prints sets a password for that account. A person made so ends the logged link as any other does.

The bootstrap token keeps working for as long as the control plane is given it. Keep it as you keep a root password; what is done with it is in the events as done by the bootstrap token.

### TLS

The proxy module speaks no TLS itself. Its `address` option says so, and the Traefik it runs is given no place to keep certificates. Put something that speaks TLS before it, on the same machine, and move the proxy to a local port:

```nix
{
  services.aperture.control.publicUrl = "https://aperture.example.com";
  services.aperture.proxy.address = "127.0.0.1:8080";

  services.nginx = {
    enable = true;
    recommendedProxySettings = true;
    # Files put into a session are as large as they are.
    clientMaxBodySize = "0";
    virtualHosts."aperture.example.com" = {
      enableACME = true;
      forceSSL = true;
      locations."/" = {
        proxyPass = "http://127.0.0.1:8080";
        proxyWebsockets = true;
      };
    };
  };
  security.acme = {
    acceptTerms = true;
    defaults.email = "ops@example.com";
  };
  networking.firewall.allowedTCPPorts = [ 80 443 ];
}
```

Whatever stands in front has to pass WebSockets (a session's socket, DevTools and tunnels are WebSockets) and requests that last: MCP answers as a stream.

Two things follow from the extra hop:

- Traefik takes what a request says of where it came from, and of whether it came over HTTPS, only from peers it is told to trust, and the control plane reads both. Tell it to trust the TLS proxy: `services.aperture.proxy.environment.TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_TRUSTEDIPS = "127.0.0.1/32";`. Without it the events name the proxy's address for everyone. The control plane itself takes `X-Forwarded-For` from this machine alone by default (`127.0.0.0/8`, `::1`); a proxy on another machine that reaches it directly is named in `APERTURE_CONTROL_TRUSTED_PROXIES`.
- A session's video and sound do not go through any proxy. They are WebRTC, from the node's UDP ports straight to the client. Set `services.aperture.node.rtcPorts` (such as `"60000-60999"`) and `openFirewall = true` so a firewall lets them through. Where they are blocked the picture comes over the session's socket instead, as encoded frames or tiles, and still works.

### A second node

A node needs three things from the control plane: its address, a registration token, and the public key of its tickets. It gives the control plane its operator token when it registers, so registering goes over TLS or a network you trust.

1. In the console, under **Registration tokens**, make a token (or `POST /api/control/registration-tokens` with `{"name": "node-b"}`). It is told once.
2. Copy `/var/lib/aperture-keys/ticket.pub.pem` from the control plane's machine.
3. On the new machine, with both files readable by the `aperture-node` user:

```nix
{
  imports = [ aperture.nixosModules.node ];

  services.aperture.node = {
    enable = true;
    name = "node-b";
    controlPlane = "https://aperture.example.com";
    listen = "10.0.0.7:7900";
    internalUrl = "http://10.0.0.7:7900";
    registrationTokenFile = "/run/secrets/aperture-registration-token";
    ticketKeyFile = "/etc/aperture/ticket.pub.pem";
    rtcPorts = "60000-60999";
    openFirewall = true;
  };
  # The proxy and the control plane reach the executor here, and nobody else needs to.
  networking.firewall.extraInputRules = "ip saddr 10.0.0.2 tcp dport 7900 accept";
}
```

`internalUrl` is where the control plane and the proxy reach the node; nothing else has to. The firewall line assumes nftables and a control plane at `10.0.0.2`; open the port however your firewall is set up. Within a couple of seconds of registering, the node is under **Nodes** in the console (`GET /api/control/nodes`) and the proxy routes to it. A node that sends no keepalive for 30 seconds gets no new sessions.

With more than one node, name a shared store on every node so that snapshots and suspended sessions are not tied to the machine they were made on:

```nix
services.aperture.node.environment = {
  APERTURE_SNAPSHOT_STORE = "s3://my-bucket/snapshots";
  APERTURE_SESSION_STORE = "s3://my-bucket/sessions";
};
# AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and, for a store that is not Amazon's,
# AWS_ENDPOINT: kept out of the Nix store.
systemd.services.aperture-node.serviceConfig.EnvironmentFile = "/run/secrets/aperture-node.env";
```

A directory the nodes share works as well, as `file:///directory`. Without a snapshot store, a snapshot is its node's alone and sessions from it start on that node; without a session store, a suspended session resumes only where it was suspended.

### Where data lives

| What | Where | Lose it and |
|---|---|---|
| Accounts, workspaces, tokens, the record of every session and snapshot, events | The PostgreSQL database `aperture-control` | The deployment is gone |
| The master key and the ticket key | `/var/lib/aperture-keys` (`master.key`, `ticket.pem`) | Nodes' operator tokens and sign-in providers' secrets cannot be read again; every ticket is refused |
| Sessions' profiles and files, snapshots, the node's operator token | `/var/lib/aperture-node` on each node | Those sessions and snapshots are gone |
| Shared snapshots and suspended sessions | The stores named by `APERTURE_SNAPSHOT_STORE` and `APERTURE_SESSION_STORE`, when set | |
| Sockets and the state of running sessions | `/run/aperture-node` | Nothing: it is made again |

Nothing that is deleted through the API or the console is removed from the database: an account, a workspace, a session's record, a token, a share link or a sign-in provider is marked deleted, found by nothing again, and its name or address is free for another. Removed for good are what a person signed in with (their password, passkeys and browser sessions), an app's codes and tokens, apps nobody ever connected, and events older than `APERTURE_CONTROL_EVENTS_KEEP`. Nothing purges what is marked.

Back up the database and `/var/lib/aperture-keys` together. A node's directory holds overlayfs layers; copy it with a tool that keeps extended attributes and device files, with the node stopped.

Stopping `aperture-node.service` leaves its sessions' browsers running, and an executor that starts again finds them. Suspend sessions first when the machine is to be changed under them.

### Health

```sh
curl -fsS http://127.0.0.1:7800/api/control/health      # {"status":"ok"}, to anyone, once the control plane serves
curl -fsS http://127.0.0.1:7900/health                  # ok, from an executor
api "$APERTURE_URL/api/control/nodes" | jq '.[] | {name, alive}'   # each node, as the control plane sees it
systemctl status aperture-control aperture-node aperture-proxy
```

`/api/control/health` is reachable through the proxy as well, which checks the proxy and its routes at the same time. The console shows the same under **Nodes**, and what was done by whom under **Audit**.

## Container image

`ghcr.io/tarik02/aperture-session:<version>` (also `:beta` for the newest beta) is **one session**: `aperture-runner serve`, with its browser, sandbox and encoders. It has no control plane, no console, no accounts, no snapshots and no PostgreSQL, and needs none. Whoever holds its token may do anything in it.

```sh
podman run --rm \
  --security-opt unmask=ALL \
  -v aperture-session:/data \
  -p 127.0.0.1:7900:7900 \
  -e APERTURE_FEATURES=sound,uploads,downloads,recordings,clipboard,mcp,cdp \
  ghcr.io/tarik02/aperture-session:beta
```

The session's token is made in `/data/token` when it first starts. The image has no shell to read it with:

```sh
podman run --rm -v aperture-session:/data --entrypoint cat docker.io/library/busybox /data/token
```

Open `http://127.0.0.1:7900/?token=<token>` for the workbench. The same token is the bearer token of the session's own routes: `/mcp`, `/cdp`, `/targets`, `/files` and the rest, as [`skills/aperture/references/session.md`](../skills/aperture/references/session.md) lists them.

What each part of that is for:

- **`--security-opt unmask=ALL`**: the browser is sandboxed inside the container, with a `/proc` of its own, which a container runtime does not let it mount over the one it masks. This is the one thing the image asks for beyond a runtime's defaults: no `--privileged`, no added capability, no device.
- **User namespaces inside the container.** The sandbox is made of them, as on a node, so whoever runs in the container has to be allowed to make one and to mount in it. A rootless podman container is: its root holds every capability over the container's own user namespace. Where the host forbids user namespaces to unprivileged users the browser does not start. Ubuntu 23.10 and newer do that through AppArmor (`kernel.apparmor_restrict_unprivileged_userns`); the image is checked on Ubuntu 24.04 with that set to `0`.
- **`/data` kept**, as a volume: the profile, the session's files and its token are there.
- **`APERTURE_FEATURES`**: every feature is off unless it is turned on.
- **`--device /dev/net/tun`** is needed only for a browser with a network of its own (`APERTURE_NETWORK_TCP=direct` or `APERTURE_NETWORK_UDP=direct`).
- **TLS and anything else in front** are yours to add. The image listens on `0.0.0.0:7900` inside the container, in plain HTTP. It has no `/health`; `GET /targets` with the token answers once the browser is up.

This is how the image is run before every release, with rootless podman. It was not run under Docker, whose default seccomp and AppArmor profiles keep a container's root from making user namespaces and mounting in them: expect to need `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined` there, or `--privileged`.

The session's browser sees the container's `/etc` no more than a node's: it has an `/etc` of its own, as [Configuration](configuration.md#what-a-sessions-browser-sees-of-the-machine) tells. The resolvers the container was given (`--dns`) are the ones the session asks for the names its pages go to.

The image is signed and carries provenance and an SBOM. Each release also has the image as a file for `docker load`, for `linux/amd64` and `linux/arm64`, with `SHA256SUMS`.

## Docker Compose

Everything on one machine, under Docker: PostgreSQL, the control plane with its console, one node, and the Traefik people reach it all through. [`deploy/compose.yaml`](../deploy/compose.yaml) is the whole of it.

```sh
curl -fsSLO https://raw.githubusercontent.com/tarik02/aperture/master/deploy/compose.yaml
echo 'APERTURE_URL=http://localhost' > .env
docker compose up --detach --wait
```

| In `.env` | Default | |
|---|---|---|
| `APERTURE_URL` | required | Where people reach it, such as `https://aperture.example.com`. Signing in takes requests from pages of that origin alone |
| `APERTURE_LISTEN` | `:80` | Where the proxy listens on the machine |
| `APERTURE_VERSION` | `beta` | The images' tag: `beta`, or a version such as `1.0.0-beta.1` |
| `APERTURE_NODE` | `node` | The node's name |
| `APERTURE_RTC_PORTS` | `60000-60999` | The UDP ports sessions' video and sound use. Open them to whoever watches a session |
| `APERTURE_FEATURES` | all of them | What the node's sessions offer at most |

What else the control plane and the node take is in [Configuration](configuration.md): add it to their `environment` in the file.

The control plane logs where the first admin is made, as under [First sign-in](#first-sign-in):

```sh
docker compose logs control | grep 'Setup link'
# Setup link: http://localhost/setup#token=…
```

Open the link, which starts with `APERTURE_URL`, and say who you are and a password: you are signed in as an admin.

The secrets are made when it first starts, in the volume `aperture_keys`, and stay as they are after. What sets a deployment up by itself uses the bootstrap token, [as there](#with-the-bootstrap-token). No image here has a shell, so it is read with another:

```sh
docker run --rm --volume aperture_keys:/keys:ro busybox cat /keys/bootstrap-token
```

What it asks of the machine:

- **The machine's own network** for the control plane, the node and the proxy. A session's video and sound go to whoever watches it straight from the node, from the addresses the node finds on its interfaces, and a container's own network has none anyone outside reaches. They talk over loopback, on ports `7800` and `7900`, and the proxy alone listens where others reach it. PostgreSQL listens on no address: the control plane is given its socket.
- **A sandbox inside the node's container**, as for the [container image](#container-image): the file gives the node `seccomp=unconfined`, `apparmor=unconfined` and `systempaths=unconfined`, and nothing else. Under podman, `unmask=ALL` takes the place of the three. Where the host forbids user namespaces to unprivileged users (Ubuntu 23.10 and newer, `kernel.apparmor_restrict_unprivileged_userns`), browsers do not start.
- **Linux**, on `amd64` or `arm64`. Docker Desktop's machine is not the one people reach.
- **TLS in front** is yours to add, as under [TLS](#tls): move the proxy to a local port with `APERTURE_LISTEN=127.0.0.1:8080`, and tell Traefik to trust what stands before it with `TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_TRUSTEDIPS` in the proxy's `environment`.

What is kept, and what losing it costs, is as in [Where data lives](#where-data-lives): the volumes `aperture_keys`, `aperture_database` and `aperture_node`.

This is brought up with Docker before every release, on Ubuntu 24.04, where a session is made in it. The images are `ghcr.io/tarik02/aperture-control` and `ghcr.io/tarik02/aperture-node`, signed with cosign, for `linux/amd64` and `linux/arm64`.
