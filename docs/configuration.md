# Configuration

Every program takes its settings from its environment. The NixOS modules set the variables below from their options; an option's `environment` attribute set passes any variable that has no option of its own.

- [Control plane](#control-plane)
- [Sign-in providers](#sign-in-providers)
- [Node](#node)
- [Session features](#session-features)
- [Proxy](#proxy)
- [Keys](#keys)
- [Origins: CORS and embedding](#origins-cors-and-embedding)

## Control plane

`aperture-control`. Options are of `services.aperture.control`. Durations are written as `30 seconds`, `10 minutes`, `90 days`.

| Variable | Module option | Type | Default | |
|---|---|---|---|---|
| `APERTURE_CONTROL_DATABASE_URL` | `database.url` | string | module: a local socket, `postgres://aperture-control@localhost/aperture-control?host=/run/postgresql`; required without the module | The PostgreSQL database. A password in the option ends up in the Nix store: prefer a socket |
| | `database.createLocally` | bool | `true` | Run PostgreSQL on this machine, with a database of the control plane's own |
| `APERTURE_CONTROL_LISTEN_HOST` | `listenHost` | string | `127.0.0.1` | The address it listens on. The proxy stands before it for anyone outside |
| `APERTURE_CONTROL_LISTEN_PORT` | `listenPort` | port | `7800` | |
| `APERTURE_CONTROL_PUBLIC_URL` | `publicUrl` | string | none | Where people reach it, such as `https://aperture.example.com`. Signing in takes requests from pages of that origin alone, and the links it hands out start with it, the one it logs for [the first admin](install.md#first-sign-in) among them. Without it the origin is whatever a request says it came to |
| `APERTURE_CONTROL_INTERNAL_URL` | `internalUrl` | string | `http://<listen host>:<listen port>` | Where the proxy reaches it, when that is not the address it listens on |
| `APERTURE_CONTROL_TRUSTED_PROXIES` | `environment` | list, comma-separated | `127.0.0.0/8,::1` | The proxies whose `X-Forwarded-For` is believed: addresses and ranges such as `10.0.0.0/8` or `fd00::/8`. A request from anywhere else came from where its connection did. One that is misspelt stops the program from starting |
| `APERTURE_CONTROL_MASTER_KEY` | `masterKeyFile` | path | module: `<keys>/master.key`; required | A file with at least 32 bytes nobody guesses. Stays the same for as long as what was sealed with it is to be read |
| `APERTURE_CONTROL_TICKET_KEY` | `ticketKeyFile` | path | module: `<keys>/ticket.pem`; required | The Ed25519 private key tickets are signed with: PKCS#8, PEM |
| `APERTURE_CONTROL_BOOTSTRAP_TOKEN_FILE` | `bootstrapTokenFile` | path | module: `<keys>/bootstrap-token` | A file with the bootstrap token, which does what an admin does, for what sets a deployment up by itself: the first admin needs none. This or the next one is required |
| `APERTURE_CONTROL_BOOTSTRAP_TOKEN` | `environment` | string | none | The bootstrap token itself, where no file holds it |
| `APERTURE_CONTROL_PROXY_TOKEN_FILE` | `proxyTokenFile` | path or none | module: `<keys>/proxy-token`; none | A file with the token the proxy reads its routes with. Without one only an admin's token reads them |
| `APERTURE_CONTROL_REGISTRATION_TOKEN_FILE` | `registrationTokenFile` | path or none | module: `<keys>/registration-token`; none | A file with a registration token that is good without an admin making it |
| `APERTURE_CONTROL_TICKET_LIFETIME` | `environment` | duration | `10 minutes` | How long a ticket is good for. A session socket opened with one stays open after |
| `APERTURE_CONTROL_NODE_SILENT_AFTER` | `environment` | duration | `30 seconds` | How long a node may send no keepalive before it gets no new sessions. Nodes are asked to send one every third of it |
| `APERTURE_CONTROL_EVENTS_KEEP` | `eventsKeep` | duration | `90 days` | How long an event is kept before it is forgotten |
| `APERTURE_CONTROL_RATE_LIMIT` | `environment` | bool | `true` | Whether signing in is held to so many tries a while from one address |
| `APERTURE_CONTROL_CONSOLE_DIR` | set by the package | path | the console the package was built with | A directory with the console's files, served beside the API. Unset, no console is served |

`<keys>` is `services.aperture.keys.directory`, `/var/lib/aperture-keys` by default. `listenHost`, `listenPort`, `package` and `environment` are the remaining options.

## Sign-in providers

People sign in with a password, a passkey, or through a provider. Passwords and passkeys need no configuration beyond `publicUrl`. There are two ways to add a provider, and both can be used at once.

**In the console**, under **Sign-in providers**, while the control plane runs. This is the way to add one that speaks OAuth 2.0 alone. The dialog starts from a preset that knows the provider's addresses and scopes: Auth0, Authelia, authentik, Dex, GitHub, GitLab, Google, Kanidm, Keycloak, Microsoft Entra ID, Okta, Pocket ID, Zitadel, or a custom OpenID Connect or OAuth 2.0 provider. Each provider says for itself whether people it vouches for are made accounts when they first come, and of which email domains. A provider is asked how it is reached before it is kept enabled; its client secret is sealed with the master key and never told again. The same is `POST /api/control/sign-in-providers` for an admin's token.

**In the settings**, for OpenID Connect providers that are part of the deployment. They are shown in the console and changed in the settings alone; where both name a provider by the same id, the settings win.

| Variable | Module option (`sso.…`) | Type | Default | |
|---|---|---|---|---|
| `APERTURE_CONTROL_SSO_PROVIDERS` | `providers.<id>` | JSON array | `[]` | The providers, each an object as below |
| `APERTURE_CONTROL_SSO_PROVISION` | `provision` | bool | `false` | Make whoever one of these providers vouches for an account when they first sign in. Without, a provider signs in only the people an admin made |
| `APERTURE_CONTROL_SSO_DOMAINS` | `domains` | list, comma-separated | any | The email domains accounts are made for so |
| `APERTURE_CONTROL_SSO_LOOPBACK_HTTP` | `environment` | bool | `false` | Lets an admin add a provider that is reached without TLS on this machine itself, for trying one out. Any other is reached with TLS whatever this says |

A provider in the settings:

| Field | Module option (`sso.providers.<id>.…`) | |
|---|---|---|
| `id` | the attribute's name | What it is known by in addresses: lowercase letters, digits and `-`, and not `credential` |
| `name` | `name` | What the sign-in page calls it. The id by default |
| `issuer` | `issuer` | Its issuer; the discovery document is looked for below it. This or the next is required |
| `discoveryUrl` | `discoveryUrl` | Its discovery document, where that is not below the issuer |
| `clientId` | `clientId` | |
| `clientSecretFile` | `clientSecretFile` | A file with the client secret, which the control plane's user reads |

```nix
services.aperture.control.sso = {
  providers.company = {
    name = "Company";
    issuer = "https://id.example.com";
    clientId = "aperture";
    clientSecretFile = "/run/secrets/aperture-oidc";
  };
  provision = true;
  domains = [ "example.com" ];
};
```

Register the client at the provider with the redirect address `<publicUrl>/api/auth/callback/<id>`, here `https://aperture.example.com/api/auth/callback/company`. A provider signs in the person whose email address it says it verified, and no second factor is asked after it.

## Node

`aperture-executor`. Options are of `services.aperture.node`; a variable with no option goes in its `environment`. Every variable is also a flag: `APERTURE_SESSION_MEMORY` is `--session-memory`.

### Where it is and who it answers to

| Variable | Module option | Type | Default | |
|---|---|---|---|---|
| `APERTURE_LISTEN` | `listen` | address, or `unix:PATH` | `127.0.0.1:7900` | The control plane and the proxy reach it there, and nobody else needs to |
| `APERTURE_NODE` | `name` | string | the machine's host name | The node's name, which no other node of the control plane has |
| `APERTURE_CONTROL_PLANE` | `controlPlane` | URL | module: `http://127.0.0.1:7800`; none | The control plane it registers with. Without one the executor serves whoever holds its operator token |
| `APERTURE_REGISTRATION_TOKEN_FILE` | `registrationTokenFile` | path | module: `<keys>/registration-token` | A file with a registration token of the control plane |
| `APERTURE_TICKET_KEY` | `ticketKeyFile` | path | module: `<keys>/ticket.pub.pem`; none | The public key of the control plane's tickets, PEM. No ticket is taken without it |
| `APERTURE_INTERNAL_URL` | `internalUrl` | URL | the address it listens on | Where the control plane and the proxy reach it |
| `APERTURE_BALANCER_URL` | `environment` | URL | none | Where the proxy reaches it, when that is another address than the control plane uses |
| `APERTURE_PUBLIC_URL` | `environment` | URL | none | Where clients reach this node's sessions directly. Tickets' links then point there and not through the proxy; TLS and [origins](#origins-cors-and-embedding) there are yours |
| `APERTURE_TOKEN_FILE` | `environment` | path | `<data dir>/token`, made when missing | The operator token |
| `APERTURE_NO_VIEWER` | `environment` | flag | off | Leave out the workbench page at `/sessions/<id>/` |

### Storage

| Variable | Module option | Type | Default | |
|---|---|---|---|---|
| `APERTURE_DATA_DIR` | fixed by the module | path | module: `/var/lib/aperture-node`; `$XDG_STATE_HOME/aperture` | Sessions' profiles and files, snapshots, the operator token |
| `APERTURE_RUNTIME_DIR` | fixed by the module | path | module: `/run/aperture-node`; `$XDG_RUNTIME_DIR/aperture` | Sockets and the state of running sessions |
| `APERTURE_SNAPSHOT_STORE` | `environment` | `s3://bucket/prefix` or `file:///directory` | none | Where snapshots are kept for every node that names the same place. Without it snapshots are their node's alone. An S3 bucket takes its region, endpoint and credentials from the usual `AWS_*` variables |
| `APERTURE_SESSION_STORE` | `environment` | as above | none | Where a session is put whenever it is suspended, so that another node resumes it |
| `APERTURE_SESSION_LOCKS` | `environment` | flag | off | Say in the session store which sessions this node has, and refuse one another node has. Needs a store that writes a file only if there is none, as S3 does |
| `APERTURE_TRANSFERS` | `environment` | integer, 1 or more | `4` | How many snapshots and sessions are on their way to or from the stores at a time |

### Limits

Resource limits need `APERTURE_SESSION_SCOPES`, which runs each session as a systemd scope of its own, `aperture-session-<id>.scope` in `aperture-sessions.slice`. The executor refuses to start with a resource limit and no scopes. The scopes are those of the systemd manager the executor runs under.

| Variable | Type | Default | |
|---|---|---|---|
| `APERTURE_SESSION_SCOPES` | flag | off | Run each session as a systemd scope |
| `APERTURE_SESSION_MEMORY` | size, such as `4G` | none | The memory a session may use. One that needs more loses a process, most likely a tab |
| `APERTURE_SESSION_SWAP` | size | none | The swap a session with a memory limit may use on top of it |
| `APERTURE_SESSION_CPUS` | number, such as `2` or `1.5` | none | The processors' worth of time a session may use |
| `APERTURE_SESSION_TASKS` | integer | none | The processes and threads a session may have |
| `APERTURE_SUSPEND_IDLE_AFTER` | time, such as `30m` | none | How long nobody may use a session before it is suspended. It is resumed when someone reaches it again. This one needs no scopes |

None of these has a module option: set them in `services.aperture.node.environment`.

### Sessions' browsers and network

| Variable | Module option | Type | Default | |
|---|---|---|---|---|
| `APERTURE_FEATURES` | `features` | list, comma-separated | module: `sound,uploads,downloads,recordings,clipboard,cdp,mcp`; none | What the node's sessions offer at most. See [Session features](#session-features) |
| `APERTURE_RTC_PORTS` | `rtcPorts` | range, such as `60000-60999` | any port | The UDP ports sessions' video and sound use. Clients reach them directly, not through the proxy |
| | `openFirewall` | bool | `false` | Open `rtcPorts` in the firewall |
| `APERTURE_EGRESS_ALLOW` | `environment` | list of addresses and networks | none | Local addresses sessions' browsers may reach, such as `10.1.2.3` or `192.168.0.0/16`. What is local to the machine and its network is otherwise refused them |
| `APERTURE_NETWORK_TCP` | `environment` | `proxied` or `direct` | `proxied` | `proxied`: a browser's TCP goes nowhere but through the session's egress, which holds it to the session's routing. `direct`: out as well, held to nothing, the local network included |
| `APERTURE_NETWORK_UDP` | `environment` | `none` or `direct` | `none` | `none`: a browser has no UDP, so pages' own WebRTC has no way out. `direct`: out, held to nothing |
| `APERTURE_NO_GPU` | `environment` | flag | off | Draw sessions on the CPU also where a GPU works |
| `--browser-arg` | | flag, repeatable | none | An argument for every session's browser. It has no variable |

The package sets the programs a session runs: `APERTURE_CHROMIUM`, `APERTURE_BWRAP`, `APERTURE_PASTA`, `APERTURE_FFMPEG`, `APERTURE_TAR`, `APERTURE_ZSTD`, `APERTURE_CURSOR_THEME`, `APERTURE_GST_PLUGIN_PATH`. Each can be set to another.

`aperture-runner serve`, which is what the container image runs, takes the browser and network settings above, and `APERTURE_DATA` (required: the session's directory), `APERTURE_LISTEN`, `APERTURE_RUNTIME_DIR`, `APERTURE_TOKEN_FILE`, `APERTURE_TICKET_KEY`, `APERTURE_SESSION_ID` and `APERTURE_CORS_ORIGINS`.

### What a session's browser sees of the machine

A session's browser runs in a sandbox with an `/etc` of its own, read only. What is in it:

| In the browser's `/etc` | Whose | Why |
|---|---|---|
| `passwd`, `group` | the session's | One user, `browser`, with the numbers the node runs as: the browser asks who it is |
| `nsswitch.conf` | the session's | Users from those files, names from `hosts` and then the resolver |
| `hosts` | the session's | `localhost` and nothing else. The names in the machine's `hosts` are not the browser's to know |
| `resolv.conf` | the session's | Only for a browser with a network of its own: it asks the session for names |
| `chromium/policies/managed`, `opt/chrome/policies/managed` | the session's | The browser's policy, which it reads from nowhere else |
| `fonts` | the machine's | How fonts are found and chosen |
| `ssl/certs`, `ssl/cert.pem`, `ssl/trust-source`, `pki/tls/certs`, `pki/tls/cert.pem`, `pki/ca-trust`, `ca-certificates` | the machine's | The certificate authorities the machine trusts, where its distribution keeps them, for the libraries of the browser that ask for them. The browser checks the sites it goes to against the authorities it comes with |
| `localtime` | the machine's | The time zone |
| `static` | the machine's | NixOS only: a link into `/nix/store`, which the files above are links through |
| `glvnd`, `drirc` | the machine's | Only for a browser that draws on a GPU: which drivers there are and how they are set |

Each of the machine's is there only where the machine has it. Nothing else of the machine's `/etc` is in the sandbox: not its `machine-id`, `os-release`, its users or its services' settings. The machine's name is not among what is kept from the browser: the sandbox is called what the machine is.

Outside `/etc` the browser sees, read only, `/usr`, `/lib`, `/lib64`, `/bin`, `/nix/store` and `/var/cache/fontconfig`, and with a GPU `/run/opengl-driver`, `/sys/dev/char` and `/sys/devices`. Whoever holds a session can read these through its DevTools, so nothing secret belongs in `/nix/store` or anywhere else that every user of the machine may read.

## Session features

A feature is something a session offers only where it is turned on. A node's sessions offer what the node does and never more; a session tells its clients which it has, and what is off is refused to everyone.

| Feature | What it turns on |
|---|---|
| `sound` | Tabs are heard |
| `uploads` | Clients put files into the session, for pages that ask for some |
| `downloads` | The browser downloads files |
| `recordings` | Tabs are recorded, and screenshots kept |
| `clipboard` | What is copied passes between the session and its clients |
| `mcp` | The session's automation endpoint. The browser tools of the control plane's `/mcp` go through it |
| `cdp` | The session's DevTools endpoint, and storage state |
| `tunnel` | Clients attach tunnels, for routing rules that say `via: local` |

All are off unless named. The module names all but `tunnel`; add it to `services.aperture.node.features` to let people reach services on their own machines from a session. On the command line a name with `-` before it turns a feature off again, and the last word on one counts: `--feature +sound --feature -uploads`.

## Proxy

Options of `services.aperture.proxy`, which runs Traefik with its static configuration in its environment.

| Module option | Type | Default | |
|---|---|---|---|
| `address` | string | `:80` | Where it listens for everyone. It speaks no TLS: see [TLS](install.md#tls) |
| `controlUrl` | URL | `http://127.0.0.1:7800` | Where it reaches the control plane |
| `pollInterval` | string | `2s` | How often it asks for its routes. A node that registers is routed to this soon after |
| `tokenEnvironmentFile` | path | `<keys>/proxy.env` | A file that sets `TRAEFIK_PROVIDERS_HTTP_HEADERS_AUTHORIZATION` to `Bearer ` and the proxy token |
| `openFirewall` | bool | `false` | Open the port of `address` |
| `package` | package | `pkgs.traefik` | |
| `environment` | attribute set | `{}` | More of Traefik's static configuration, as its `TRAEFIK_` variables |

Another proxy can stand in its place if it does what this one is told to: the routes are served, as Traefik's dynamic configuration, at `GET /api/control/route/traefik` for the proxy token. Every request below `/n/<node>/` is first asked of the control plane at `GET /api/control/route/admit`, with the original address in `X-Forwarded-Uri`; the `Authorization` header of the answer replaces the request's, the cookies are taken off, the `/n/<node>` prefix is stripped, and the request goes to the node. Everything else goes to the control plane.

## Keys

Options of `services.aperture.keys`.

| Module option | Type | Default | |
|---|---|---|---|
| `enable` | bool | `false` (`true` with `standalone`) | Make the secrets of a deployment on this machine, once |
| `directory` | path | `/var/lib/aperture-keys` | Where they are kept |

[Install](install.md#keys-and-tokens) lists the files.

## Origins: CORS and embedding

There is no list of allowed origins on the control plane, and none is needed for the usual case.

- **The REST API** (`/api/control/*`) sends no CORS headers. A page of another origin cannot call it from a browser; call it from your backend.
- **`/mcp` and the OAuth endpoints** answer pages of any origin. They take no cookies, so a page gets nothing by it that it would not get from anywhere else.
- **Signing in** takes requests from pages of `publicUrl` alone.
- **A session's own routes on a node** are closed to pages of other origins unless the node names them: `APERTURE_CORS_ORIGINS` (or `--cors-origin`, repeatable) takes origins such as `https://app.example.com`, or `*` for any. Set it in `services.aperture.node.environment` on every node. A page that [embeds a session](using.md#embedding-a-session) with a ticket needs this only for what it fetches from the session over HTTP, such as the lists of files and recordings; the session's socket, and the picture, input and sound that go over it, are not held to it.
- **The same routes through the proxy** are not open to other origins yet, whatever the node names. Before a request that carries a ticket in a header, a browser asks whether it may, without the ticket, and the proxy's admission refuses what carries none. So a page on another origin than the proxy's gets the workbench with its picture, input, tabs and sound, and its file and recording lists fail. Serve the embedding page from the proxy's origin, or give nodes an `APERTURE_PUBLIC_URL` of their own, where those lists matter.
- **Framing**: the console and the workbench send no header that forbids showing them in a frame of another page.
