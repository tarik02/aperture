#!/usr/bin/env bash
# Unpacks a release's runner and browser where `aperture run` and the runner keep them,
# starts a session with them where nothing of the machine's Nix is to be found, and asks it
# from outside what smoke-image.sh asks the image: the session answers, and a page loads
# over HTTPS.
set -euo pipefail

runner="$(realpath "${1:?usage: smoke-bundles.sh RUNNER-BUNDLE BROWSER-BUNDLE}")"
browser="$(realpath "${2:?usage: smoke-bundles.sh RUNNER-BUNDLE BROWSER-BUNDLE}")"
version="$(basename "$runner")"
version="${version#aperture-runner-}"
version="${version%-linux-*}"

work="$(mktemp -d)"
cache="$work/cache"
data="$work/data"
log="$work/runner.log"
mkdir -p "$work/runner" "$cache/aperture/chromium/$version"
zstd --decompress --stdout "$runner" | tar --extract --directory "$work/runner"
zstd --decompress --stdout "$browser" | tar --extract --directory "$cache/aperture/chromium/$version"

# A group of its own, which is how `aperture run` stops it. With no `APERTURE_CHROMIUM` and
# no browser in `PATH`, the session's browser is the one unpacked above.
env -i HOME="$HOME" PATH=/usr/bin:/bin XDG_CACHE_HOME="$cache" \
  setsid "$work/runner/bin/aperture-runner" serve \
  --data "$data" --listen 127.0.0.1:0 --feature mcp > "$log" 2>&1 &
group=$!

ended() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    tail -n 80 "$log" || true
  fi
  kill -TERM -- "-$group" 2> /dev/null || true
  for ((waited = 0; waited < 30; waited++)); do
    kill -0 -- "-$group" 2> /dev/null || break
    sleep 1
  done
  kill -KILL -- "-$group" 2> /dev/null || true
}
trap ended EXIT

for ((waited = 0; waited < 120; waited++)); do
  if [[ -s "$data/address" && -s "$data/token" ]]; then
    break
  fi
  kill -0 "$group" 2> /dev/null || { echo "the runner ended" >&2; exit 1; }
  sleep 1
done
url="http://$(cat "$data/address")"
token="$(cat "$data/token")"

# Looks every second for a tab the session tells of that matches, for as long as given.
tab() {
  local filter="$1" seconds="$2"
  for ((waited = 0; waited < seconds; waited++)); do
    if curl -fsS -m 5 -H "Authorization: Bearer $token" "$url/targets" 2> /dev/null | jq -e "$filter" > /dev/null; then
      return 0
    fi
    kill -0 "$group" 2> /dev/null || { echo "the runner ended" >&2; return 1; }
    sleep 1
  done
  echo "no tab matched $filter within $seconds seconds" >&2
  return 1
}

tab 'length > 0' 120

mcp() {
  curl -fsS -m 60 -D "$headers" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    "$@" "$url/mcp"
}
headers="$work/headers"
mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' > /dev/null
session="$(tr -d '\r' < "$headers" | sed -n 's/^mcp-session-id: //Ip')"
agreed=(-H "mcp-session-id: $session" -H 'mcp-protocol-version: 2025-06-18')
mcp "${agreed[@]}" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
mcp "${agreed[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"navigate","arguments":{"url":"https://example.com/"}}}' > /dev/null

tab 'any(.[]; .url == "https://example.com/" and .title == "Example Domain")' 60
echo "the session answers, and a page loaded over HTTPS"
