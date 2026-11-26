# Monitoring

The control plane and each node serve Prometheus metrics at `GET /metrics`, each on an address of its own, apart from the one its API is on. Neither serves any until it is given that address. The endpoints have no authentication: keep them on loopback, or let only the machine Prometheus runs on reach them.

## Enable metrics

| Program | Variable | NixOS option | Example |
|---|---|---|---|
| Control plane | `APERTURE_CONTROL_METRICS_LISTEN` | `services.aperture.control.metrics.enable`, `.listen` (`127.0.0.1:9465`) | `127.0.0.1:9465`, `[::1]:9465` |
| Node | `APERTURE_METRICS_LISTEN` (`--metrics-listen`) | `services.aperture.node.metrics.enable`, `.listen` (`127.0.0.1:9464`) | `127.0.0.1:9464`, `unix:/run/aperture-node/metrics.sock` |
| Node | `APERTURE_METRICS_NO_PER_SESSION` (`--metrics-no-per-session`) | `services.aperture.node.metrics.perSession` (`true`) | |

```nix
services.aperture.control.metrics.enable = true;
services.aperture.node.metrics.enable = true;
```

The modules' addresses are on loopback, and the two differ so that both programs of one machine serve theirs. With Docker Compose, set `APERTURE_CONTROL_METRICS_LISTEN` and `APERTURE_NODE_METRICS_LISTEN` in `.env`; the containers use the host's network, so the addresses are the host's.

## Scrape configuration

```yaml
scrape_configs:
  - job_name: aperture-control
    static_configs:
      - targets: ["127.0.0.1:9465"]
  - job_name: aperture-node
    static_configs:
      - targets: ["127.0.0.1:9464"]
```

A node's metrics are its own; for several nodes, list each, or scrape them by the machines' names. The control plane's are the same from any of its programs that share a database, apart from what each counted itself.

## Metrics

Every name starts with `aperture_`. No label carries a token, a user, a URL or a path, and only the optional per-session series carry a session's id. A route is its template, such as `/api/control/sessions/:id`; a request that no route matched is `unmatched`.

### Node

| Metric | Type | Labels |
|---|---|---|
| `aperture_sessions` | gauge | `status`: `suspended`, `starting`, `restoring`, `running`, `suspending`, `failed` |
| `aperture_session_events_total` | counter | `event`: `created`, `started`, `failed` (a browser that did not start), `suspended`, `idle_suspended`, `deleted` |
| `aperture_session_start_duration_seconds` | histogram | `kind`: `create`, `resume`, `wake`, `snapshot` |
| `aperture_storage_size_bytes` | gauge | `root`: `data` |
| `aperture_storage_available_bytes` | gauge | `root`: `data` |
| `aperture_state_scrape_errors_total` | counter | `source`: `sessions`, `storage` |
| `aperture_node_up` | gauge | 1 while the control plane takes the node's keepalives, 0 while it does not; only on a node that registers |
| `aperture_node_keepalives_total` | counter | `result`: `ok`, `failed`; only on a node that registers |
| `aperture_node_last_keepalive_timestamp_seconds` | gauge | only on a node that registers |
| `aperture_build_info` | gauge | `version`, `commit`; always 1 |

`aperture_sessions` and the storage are read on every scrape. A start's duration runs from starting the session's runner until its browser serves; `wake` is a session someone reached after it was suspended for sitting idle, and `snapshot` one that runs again after its profile was taken as a snapshot. `started` counts each of these.

#### Per-session resources

With `APERTURE_SESSION_SCOPES`, which runs each session as a systemd scope, the node reads what each running session uses from its scope's cgroup. Each series has the label `session_id` and is there only while the session runs: five for each session that runs. Turn them off on a node with many sessions, with `perSession = false`.

| Metric | Type | |
|---|---|---|
| `aperture_session_memory_bytes` | gauge | `memory.current`, page cache the session caused among it |
| `aperture_session_memory_peak_bytes` | gauge | `memory.peak` |
| `aperture_session_cpu_seconds_total` | counter | `cpu.stat` `usage_usec` |
| `aperture_session_tasks` | gauge | processes and threads |
| `aperture_session_oom_kills_total` | counter | processes the kernel killed for the session's memory |

### Control plane

| Metric | Type | Labels |
|---|---|---|
| `aperture_http_requests_total` | counter | `route`, `method`, `status_class` (`2xx`, `4xx`, …) |
| `aperture_http_request_duration_seconds` | histogram | `route`, `method` |
| `aperture_control_sessions` | gauge | `node` (empty for a session gone from its node), `desired_state`, `observed_state` |
| `aperture_control_nodes` | gauge | every node that ever registered |
| `aperture_control_nodes_silent` | gauge | the nodes that sent no keepalive for longer than `APERTURE_CONTROL_NODE_SILENT_AFTER` |
| `aperture_control_session_requests_total` | counter | `action`: `create`, `resume`, `suspend`, `delete`; `outcome`: `ok`, `refused` (the caller's, such as no access), `failed` (no node, or the node's) |
| `aperture_mcp_tool_calls_total` | counter | `tool`; `outcome`: `ok`, `error` (the tool said it failed), `failed` |
| `aperture_auth_logins_total` | counter | `method`: `password`, `passkey`, `two_factor`, `provider` |
| `aperture_auth_failures_total` | counter | `method`, `reason` (the code it was refused with) |
| `aperture_build_info` | gauge | `version`, `commit`; always 1 |

`aperture_control_sessions` and the nodes are read from the database on every scrape. A series of a counter is there from the first time it is counted.

## From v1

v1's names stay where the thing they count is the same; its daemon was one program, and these are now the control plane's or a node's.

| v1 | v2 |
|---|---|
| `aperture_http_requests_total`, `aperture_http_request_duration_seconds` | the same, of the control plane |
| `aperture_http_requests_in_flight`, `aperture_api_errors_total` | none; `status_class` of `aperture_http_requests_total` |
| `aperture_auth_logins_total`, `aperture_auth_failures_total` | the same, of the control plane; the methods are v2's |
| `aperture_sessions{status}` | the same, of each node, with v2's states; `aperture_control_sessions` for all of them by node |
| `aperture_session_events_total{event}` | the same, of each node: `created`, `started`, `suspended`, `deleted`, `failed` as before; `idle_suspended` is new, and `woken`, `reopened` and `expired` are gone |
| `aperture_session_start_duration_seconds{kind}` | the same, of each node: `create` and `wake` as before, `resume` for `reopen`, and `snapshot` |
| `aperture_storage_size_bytes`, `aperture_storage_available_bytes` | the same, of each node, with the root `data` |
| `aperture_state_scrape_errors_total` | the same, of each node |
| `aperture_session_cpu_seconds_total`, `aperture_session_memory_bytes`, `aperture_session_memory_peak_bytes`, `aperture_session_tasks` | the same, of each node, from its scopes alone |
| `aperture_session_oom_kills_total` | new |
| `aperture_build_info{version,commit,color}` | the same, without `color`: v2 has no blue and green |
| `aperture_snapshot_*`, `aperture_gc_*`, `aperture_database_size_bytes`, `aperture_snapshots`, the live-session, upload, recording and proxy metrics, `aperture_session_swap_bytes`, `aperture_session_io_*` | none yet |
| `go_*`, `process_*` | none |
