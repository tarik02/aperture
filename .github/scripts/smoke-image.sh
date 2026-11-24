#!/usr/bin/env bash
# Starts the session's image as docs/install.md tells its users to, and asks it from outside
# what they would: the session answers, the workbench is served, and a page loads over HTTPS.
set -euo pipefail

archive="${1:?usage: smoke-image.sh IMAGE-ARCHIVE [PORT]}"
port="${2:-7900}"
name=aperture-smoke
url="http://127.0.0.1:$port"

image="$(podman load --input "$archive" | sed -n 's/^Loaded image: //p' | tail -n 1)"

ended() {
  if [[ $? -ne 0 ]]; then
    podman logs "$name" 2>&1 | tail -n 60 || true
  fi
  podman rm --force --volumes "$name" > /dev/null 2>&1 || true
  podman volume rm --force "$name" > /dev/null 2>&1 || true
}
trap ended EXIT

podman run --detach --name "$name" \
  --security-opt unmask=ALL \
  -v "$name:/data" \
  -p "127.0.0.1:$port:7900" \
  -e APERTURE_FEATURES=sound,uploads,downloads,recordings,clipboard,mcp,cdp \
  "$image" > /dev/null

# Looks every second for a tab the session tells of that matches, for as long as given.
tab() {
  local filter="$1" seconds="$2" token
  for ((waited = 0; waited < seconds; waited++)); do
    # The image has no shell to read the token with.
    if token="$(podman cp "$name:/data/token" - 2> /dev/null | tar -xO 2> /dev/null)" \
      && [[ -n "$token" ]] \
      && curl -fsS -m 5 -H "Authorization: Bearer $token" "$url/targets" 2> /dev/null | jq -e "$filter" > /dev/null; then
      echo "$token"
      return 0
    fi
    if [[ "$(podman inspect --format '{{.State.Running}}' "$name")" != true ]]; then
      echo "the container ended" >&2
      return 1
    fi
    sleep 1
  done
  echo "no tab matched $filter within $seconds seconds" >&2
  return 1
}

token="$(tab 'length > 0' 120)"

workbench="$(curl -fsS -m 10 "$url/?token=$token")"
grep -qi '<!doctype html' <<< "$workbench"

mcp() {
  curl -fsS -m 60 -D "$headers" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    "$@" "$url/mcp"
}
headers="$(mktemp)"
mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' > /dev/null
session="$(tr -d '\r' < "$headers" | sed -n 's/^mcp-session-id: //Ip')"
agreed=(-H "mcp-session-id: $session" -H 'mcp-protocol-version: 2025-06-18')
mcp "${agreed[@]}" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
mcp "${agreed[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"navigate","arguments":{"url":"https://example.com/"}}}' > /dev/null

tab 'any(.[]; .url == "https://example.com/" and .title == "Example Domain")' 60 > /dev/null

echo "the session answers, and a page loaded over HTTPS"
