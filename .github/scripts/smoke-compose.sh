#!/usr/bin/env bash
# Brings deploy/compose.yaml up with Docker as docs/install.md tells its users to, on the
# images given, and asks it from outside what they would: the console is served, the node
# registered, and a session an account makes shows a tab.
set -euo pipefail

control="${1:?usage: smoke-compose.sh CONTROL-IMAGE-ARCHIVE NODE-IMAGE-ARCHIVE [PORT]}"
node="${2:?usage: smoke-compose.sh CONTROL-IMAGE-ARCHIVE NODE-IMAGE-ARCHIVE [PORT]}"
port="${3:-8080}"
url="http://127.0.0.1:$port"
api="$url/api/control"

export APERTURE_VERSION=smoke
export APERTURE_URL="$url"
export APERTURE_LISTEN="127.0.0.1:$port"
compose=(docker compose --project-name aperture-smoke --file "$(dirname "$0")/../../deploy/compose.yaml")

for part in control node; do
  archive="${!part}"
  loaded="$(docker load --input "$archive" | sed -n 's/^Loaded image: //p' | tail -n 1)"
  docker tag "$loaded" "ghcr.io/tarik02/aperture-$part:$APERTURE_VERSION"
done

ended() {
  if [[ $? -ne 0 ]]; then
    "${compose[@]}" ps --all || true
    for part in keys postgres control node proxy; do
      "${compose[@]}" logs --tail 40 "$part" || true
    done
  fi
  "${compose[@]}" down --volumes > /dev/null 2>&1 || true
}
trap ended EXIT

"${compose[@]}" up --detach --wait --wait-timeout 300

# Asks until what answers passes the filter, for as long as given.
until_answers() {
  local filter="$1" seconds="$2"
  shift 2
  for ((waited = 0; waited < seconds; waited++)); do
    if curl -fsS -m 5 "$@" 2> /dev/null | jq -e "$filter" > /dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "nothing matched $filter within $seconds seconds: $*" >&2
  return 1
}

# No image of the deployment has a shell to read the token with.
bootstrap="$(docker run --rm --volume aperture-smoke_keys:/keys:ro busybox cat /keys/bootstrap-token)"
call() {
  local token="$1" method="$2" path="$3"
  shift 3
  curl -fsS -m 30 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$@" "$api$path"
}

curl -fsS -m 10 "$url/" | grep -q '<title>Aperture</title>'
until_answers '.[0].alive and .[0].offers != null' 120 -H "Authorization: Bearer $bootstrap" "$api/nodes"

account="$(call "$bootstrap" POST /accounts -d '{"name":"ops"}' | jq -er .id)"
token="$(call "$bootstrap" POST "/accounts/$account/tokens" -d '{"name":"check","scopes":["sessions:write"]}' | jq -er .token)"
path="$(call "$token" POST /sessions -d '{}' | jq -er .path)"
until_answers 'length >= 1' 120 -H "Authorization: Bearer $token" "$url$path/targets"

echo "the console is served, the node registered, and a session shows a tab"
