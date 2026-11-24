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
- **OAuth**, for MCP clients: no token is copied anywhere. See below.
- **A ticket** is a signed pass into one session for about ten minutes, made from an API token. It is what a browser is given.

Scopes: `sessions:read`, `sessions:write`, `snapshots:read`, `snapshots:write`, `workspaces:read`, `workspaces:write`, `events:read`, `tokens:write`, `admin`. Writing includes reading. `sessions:read` sees sessions and watches them; everything else in a session, the browser tools included, takes `sessions:write`. A token can also be held to named workspaces, sessions and snapshots.

## Connecting an agent over MCP

Point the MCP client at `$APERTURE_URL/mcp`. It speaks MCP over HTTP.

- **With OAuth.** A client that supports it needs the URL alone: it finds the authorization server from the endpoint, registers itself, and sends a person to the console to approve the scopes it asks for, and, if they choose, the workspaces, sessions and snapshots it may reach. What was approved is listed in the console under **Account**, **Connections**, and is taken back there.
- **With an API token.** Send `Authorization: Bearer apc_…` with every request. This is the way for an agent that runs unattended; give it a service account's token with the scopes it needs.

The server lists its tools with their arguments: `sessions.create`, `sessions.list`, `sessions.suspend`, `sessions.promote`, `sessions.ticket`, `shares.create` and the rest for sessions, snapshots and workspaces. The browser tools (`navigate`, `snapshot`, `click`, …) act in the session named by their `session_id`. They are a running session's own, so they are listed once a session runs; before that, `sessions.tools` and `sessions.call` reach them. They need the `mcp` [feature](configuration.md#session-features) on the node.

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

A session is running once its `observedState` is `running`. Its own routes (`/targets`, `/files`, `/cdp`, `/mcp` and the rest) are below `$APERTURE_URL<path>`, and take the same API token; [`session.md`](../skills/aperture/references/session.md) lists them.

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
