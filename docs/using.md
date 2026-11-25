# Using Aperture

One origin serves everything. Below, `$APERTURE_URL` is that origin, such as `https://aperture.example.com`.

| What | Where |
|---|---|
| The console, for people | `$APERTURE_URL/` |
| MCP, for agents | `$APERTURE_URL/mcp` |
| The REST API | `$APERTURE_URL/api/control/*` |
| A session's own routes | `$APERTURE_URL<path>/*`, with `path` as the session says it |

This page is the short version. [`skills/aperture`](../skills/aperture/SKILL.md) is written for agents and has the workflows step by step: driving a page, keeping a signed-in profile, recording, moving files, handing a session to a person, routing its network.

## Credentials

- **An API token** (`apc_…`) is an account's, and does what its scopes name. A person makes one in the console under **Account**, **API tokens**; an admin makes one for a service account under **Service accounts**. It is told once.
- **OAuth**, for MCP clients and [the Companion extension](#the-companion-extension): no token is copied anywhere. See below.
- **A ticket** is a signed pass into one session for about ten minutes, made from an API token. It is what a browser is given.

Scopes: `sessions:read`, `sessions:write`, `snapshots:read`, `snapshots:write`, `workspaces:read`, `workspaces:write`, `events:read`, `tokens:write`, `admin`. Writing includes reading. `sessions:read` sees sessions and watches them; everything else in a session, the browser tools included, takes `sessions:write`. A token can also be held to named workspaces, sessions and snapshots.

An admin sees every workspace, its sessions and snapshots, and watches its sessions, but acts only in the workspaces they are a member of: in another, they join it first (in the console, **Join** on the **Workspaces** page, which lists the others under **All workspaces**). This holds for a console session and for a token with the `admin` scope alike.

## Connecting an agent over MCP

Point the MCP client at `$APERTURE_URL/mcp`. It speaks MCP over HTTP.

- **With OAuth.** A client that supports it needs the URL alone: it finds the authorization server from the endpoint, registers itself, and sends a person to the console to approve the scopes it asks for, and, if they choose, the workspaces, sessions and snapshots it may reach. What was approved is listed in the console under **Account**, **Connections**, and is taken back there.
- **With an API token.** Send `Authorization: Bearer apc_…` with every request. This is the way for an agent that runs unattended; give it a service account's token with the scopes it needs.

The server lists its tools with their arguments: `sessions.create`, `sessions.list`, `sessions.suspend`, `sessions.promote`, `sessions.ticket`, `shares.create` and the rest for sessions, snapshots and workspaces. The browser tools (`navigate`, `snapshot`, `click`, …) act in the session named by their `session_id`. They are listed from the start, before any session runs, as the sessions of the control plane's own version have them; a session on a node of another version may have others, which `sessions.tools` lists and `sessions.call` calls by name. They need the `mcp` [feature](configuration.md#session-features) on the node.

## The REST API

```sh
api() { curl -fsS -H "Authorization: Bearer $APERTURE_TOKEN" -H 'Content-Type: application/json' "$@"; }

api "$APERTURE_URL/api/control/account"                      # what this token is for
SESSION=$(api -X POST "$APERTURE_URL/api/control/sessions" -d '{"label":"demo"}' | jq -r .id)
api "$APERTURE_URL/api/control/sessions/$SESSION" | jq '{observedState, path}'
api -X DELETE "$APERTURE_URL/api/control/sessions/$SESSION"
```

`$APERTURE_URL/api/control/openapi.json` is the OpenAPI document: every route, body and error. A refusal is a JSON object with a `_tag`, such as `{"_tag": "SessionNotFound", "id": "…"}`.

From TypeScript, [`@aperture-browser/control-api`](../packages/control-api) is the same API as a typed client.

A session can be created with what its browser is to start with: `storageState` in the body of `POST /sessions` is a [storage state](../skills/aperture/references/session.md#storage-state), with cookies, the storage of origins and the tabs to open. The request answers once the session's browser runs, with `observedState` `restoring`: the state is put in after, storage and cookies before any of its tabs is opened. The session is `running` once all of it is in. Ask for it until then, as a session takes no input, runs no browser tool and offers no DevTools while it is being restored; whoever opens it meanwhile sees its tabs arrive. One whose browser does not take the state is stopped and `failed`, with `failure` saying why.

A session is ready once its `observedState` is `running`. Its own routes (`/targets`, `/files`, `/cdp`, `/mcp` and the rest) are below `$APERTURE_URL<path>`, and take the same API token; [`session.md`](../skills/aperture/references/session.md) lists them.

## Recording a tab

A recording is a tab's raw video, with the pointer in it, and a journal of what automation did meanwhile. Nothing about the cut is said when it starts. It is said when it stops, and the edit is made of the raw video then: a second video, with a timeline that maps one to the other.

| Option | What it does | Default |
|---|---|---|
| `capture` | `continuous` keeps the tab from start to stop; `bursts` keeps only the stretches around what automation did | `continuous` |
| `idle` | `cut` leaves out the stretches in which nothing happens, `speed` plays them faster; a caption is kept at normal speed for as long as it shows; continuous capture only | none |
| `ripple` | Marks clicks | `false` |
| `fps` | The edit's frames a second, 1 to 60. The raw video has 60 at most, so more would only repeat them | `60` |
| `motion_threshold` | The share of the picture, 0 to 1, that must change for something to have happened | `0.0002` |
| `burst` | A burst's sizes in ms: `lead_ms`, `tail_ms`, `settle_ms`, `max_tail_ms` | `500`, `800`, `400`, `3000` |

The raw video stays, so the edit is made again with other options whenever the cut is wrong. The new edit takes the place of the one before, under the same file name, and the recording tells which options made the one there is (`edit.options`, `edit.made_at_ms`). It is refused while an edit of that recording is being made, and for a recording whose raw video was removed from the session's files. Recordings of the session's earlier runs are edited again as well.

- **In the workbench**, **Stop recording** in the recording menu stops with what that browser last chose under **When a recording stops**, in the same menu. A finished recording has **Edit again…** in its player.
- **Over MCP**, `recording` with `action: "stop"` takes the options, and `action: "edit"` makes the edit again.
- **Over HTTP**, `POST /recordings/{id}/stop` and `POST /recordings/{id}/edit` take them as a JSON body.

How automation moves the pointer in a recorded tab is not a recording's but the session's: its **pace**, `instant`, `fast` (the default) or `slow`. Every recording that runs shares it, everyone in the session sees the same, and it stays over a suspend. Set it with the `pace` tool, `PUT /pace`, or **Automation pace** in the workbench's menu. A tab nothing records gets automation's input at once whatever the pace is. The pointer's way is in the raw video, so a later edit does not change it.

## Embedding a session

A page of yours shows a session with a ticket. Your backend holds the API token and asks for the ticket; the page never sees the token.

1. **The backend asks for a ticket**, saying what its holder may do. With no `access` they watch, which takes `sessions:read`; with any, the token needs `sessions:write`.

   ```sh
   api -X POST "$APERTURE_URL/api/control/sessions/$SESSION/tickets" \
     -d '{"name":"Ada","access":{"input":"rw","tabs":"rw","lease":"rw","clipboard":"rw"}}'
   # {"ticket": "…", "expiresAt": "…", "url": "https://aperture.example.com/n/<node>/sessions/<id>/?token=…"}
   ```

   The areas of `access` are `input`, `tabs`, `lease`, `sound`, `clipboard`, `uploads`, `downloads`, `recordings`, `proxy`, `mcp`, `cdp`, `tunnel`, each `r`, `w` or `rw`.

2. **The page shows the session.** What comes before the `?` of `url` is the session's base. With React:

   ```sh
   npm install @aperture-browser/session-react@beta react react-dom effect
   ```

   ```tsx
   import { ApertureSession } from "@aperture-browser/session-react";
   import "@aperture-browser/session-react/styles.css";

   /** `admission` is what the backend was answered with. */
   export function Browser({ admission }: { admission: { url: string; ticket: string } }) {
     const [base = admission.url] = admission.url.split("?");
     return (
       <div style={{ height: "100dvh" }}>
         <ApertureSession
           url={base}
           token={admission.ticket}
           name="Ada"
           features={{ recordings: false, files: false }}
         />
       </div>
     );
   }
   ```

   The workbench fills its parent, which needs a height. Without React, [`@aperture-browser/session-element`](../packages/session-element) is the same workbench as a custom element that brings React with it:

   ```html
   <script type="module">
     import "@aperture-browser/session-element";
   </script>

   <aperture-session url="BASE" token="TICKET" name="Ada" hide="recordings files" style="height: 100dvh"></aperture-session>
   ```

Things to know:

- **`url` by itself is a page too.** Opening the ticket's `url` in a browser, or in an `<iframe>`, shows the session's own workbench with nothing to install.
- **A ticket runs out**, after ten minutes by default. A page that is open stays connected; ask for a fresh ticket when the page is opened again.
- **The path changes** when a session moves to another node. Take the base from a fresh ticket's `url`, not from one you stored.
- **Another origin than Aperture's** gets the picture, input, tabs and sound. What the workbench fetches from the session over HTTP, such as its files and recordings, is held to [the origins the node names](configuration.md#origins-cors-and-embedding), and through the proxy is not open to other origins yet: leave `files` and `recordings` out, as above, or serve the page from Aperture's origin.
- `features` leaves parts of the workbench out, and `contributions` adds to its menus and toolbar. [`@aperture-browser/session-client`](../packages/session-client) is the client under both, for a page that draws everything itself.

## Share links

A share link lets someone with no account into one session, to watch or to control, until it runs out or is taken back. In the console it is **Share** on a session; over the API:

```sh
api -X POST "$APERTURE_URL/api/control/sessions/$SESSION/shares" \
  -d '{"name":"For the reviewer","role":"watch","expiresInHours":24}' | jq -r .url
# https://aperture.example.com/share/<id>#<secret>
```

The `url` is told once. Whoever opens it says what the others are to call them and is shown the session's workbench and nothing else: a guest who controls gives input, changes tabs and has the clipboard and the sound; files, routing, automation and DevTools are no guest's. `DELETE /api/control/sessions/{id}/shares/{shareId}` takes the link back and puts its guests out at once.

For someone who has an account and is to look now, a ticket's `url` does the same without a link to keep.

## The Companion extension

The Aperture Companion is an extension for a Chromium browser of your own. It takes the tabs you choose, with what their sites keep in your browser, and opens them in a new session, signed in as you were: this is called a teleport. It can put them into a snapshot instead, for sessions to start from later.

**Loading it.** Each release has an `aperture-companion-<version>.zip`. Extract it, open `chrome://extensions`, turn on **Developer mode** and choose **Load unpacked** on the extracted directory. From a checkout, `pnpm --filter @aperture-browser/companion build` and load `extensions/aperture-companion/dist`.

**Connecting.** Open the extension, enter `$APERTURE_URL` and choose one of:

- **Connect with Aperture.** A window opens on the console: sign in and approve what the extension asks for. It is listed under **Account**, **Connections**, and is taken back there; removing the connection in the extension takes it back as well.
- **Use API token instead.** An `apc_…` token with `sessions:write`. Add `snapshots:read` to start sessions from snapshots, and `snapshots:write` to teleport into a snapshot.

Either way the token stays in the extension's own storage on that machine. Where the account is in workspaces, the extension asks which one a teleport goes to; **Personal** is the account's own.

**What a teleport moves.** For every tab you choose, and every frame in it:

| | |
|---|---|
| Cookies | Those the frames could send, `HttpOnly` ones included, and those the browser keeps apart for the site a frame is embedded in |
| Local storage, IndexedDB, Cache Storage, private files (OPFS) | Of each origin, on its own and as it is embedded in the tab's page. Dates, bytes, maps, files and Web Crypto keys that may be exported keep their kind |
| Session storage, `window.name`, `history.state` | Of each tab, there before the page's own scripts run |
| What the page shows | Form values, editable text, what has the focus, the selection, and how far the page and its parts are scrolled |
| The tabs themselves | Each at its address; one that another opened keeps it as its opener |

**What it cannot move:** files chosen in a form, keys that may not leave the browser, what a page keeps in memory alone, the inside of a closed shadow root, the document state of frames (their storage is moved), and cache entries the browser does not let a page read. Each origin's databases, caches and files are taken up to 32 MiB a kind, and a whole teleport up to 48 MiB: what is left out for its size is said when the teleport ends. Pages are loaded again in the session, so a site sees a new browser at another address with your cookies; some sites sign such a browser out.

A teleport into a session is done once the session is created: its page opens at once and says that it is being restored, and what is put in, while the tabs arrive behind. Nothing is pressed in it until all of it is in.

A teleport into a snapshot makes a session, waits until it is restored, takes a snapshot of it at rest and deletes the session; the extension says which of these it is at. What a page shows does not outlast that; cookies and storage do. A snapshot name that is taken already in the place you chose is refused before anything is made.
