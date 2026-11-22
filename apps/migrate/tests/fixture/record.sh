#!/usr/bin/env bash
# Records the v1 installation the checks migrate: a real v1, run from its image on a volume
# of its own, with tenants, people, tokens, sessions and a snapshot of a browser that is
# signed in to a site. What it leaves is v1.tar.gz beside this file.
#
#   nix build <v1 checkout>#aperture-docker && podman load -i result
#   record.sh localhost/aperture:<version>
#
# It needs podman, curl, jq, node, tar and gzip, and touches nothing but the container and
# the volume it names itself.
set -euo pipefail

image=${1:?the v1 image, as podman knows it}
here=$(cd "$(dirname "$0")" && pwd)
name=aperture-migrate-fixture
port=18080
site_port=18081
work=$(mktemp -d)
url=http://127.0.0.1:$port

cleanup() {
  [ -n "${site_pid:-}" ] && kill "$site_pid" 2>/dev/null || true
  podman rm -f "$name" >/dev/null 2>&1 || true
  podman volume rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup_before=$(podman volume exists "$name" && echo yes || echo no)
[ "$cleanup_before" = no ] || { echo "the volume $name is there already" >&2; trap - EXIT; exit 1; }

podman volume create "$name" >/dev/null
podman run --rm -v "$name":/var/lib/aperture -v "$work":/provision \
  -e APERTURE_EXTERNAL_BASE_URL=$url --entrypoint aperture-server "$image" \
  --config /etc/aperture/aperture.toml admin provision \
  --admin-token-file /provision/admin-token --default-tenant default >/dev/null
podman run --rm -v "$name":/var/lib/aperture --entrypoint /bin/sh "$image" \
  -c 'chown -R aperture:aperture /var/lib/aperture'
podman run -d --name "$name" --cap-add SYS_ADMIN --shm-size 2g --stop-timeout 35 \
  --tmpfs /run/aperture:rw,nosuid,nodev,size=512m -v "$name":/var/lib/aperture \
  -e APERTURE_EXTERNAL_BASE_URL=$url --network pasta -p 127.0.0.1:$port:8080 "$image" >/dev/null
for _ in $(seq 1 60); do curl -fsS $url/api/health >/dev/null 2>&1 && break; sleep 1; done

admin=$(cat "$work/admin-token")
api() { # token method path [body] [tenant]
  curl -sS --fail-with-body -X "$2" "$url$3" -H "Authorization: Bearer $1" \
    ${4:+-H 'Content-Type: application/json' -d "$4"} ${5:+-H "X-Aperture-Tenant-Id: $5"} \
    || { echo " <- $2 $3" >&2; return 1; }
}

# The site the browser signs in to, in the container's own network: its sandbox reaches
# nothing else of this machine.
pid=$(podman inspect -f '{{.State.Pid}}' "$name")
podman unshare nsenter --net=/proc/"$pid"/ns/net "$(command -v node)" -e '
  require("node:http").createServer((request, response) => {
    const signedIn = (request.headers.cookie ?? "").includes("sid=alice-secret");
    if (request.url === "/login") {
      response.setHeader("Set-Cookie", "sid=alice-secret; Max-Age=315360000; Path=/; HttpOnly");
      response.setHeader("Content-Type", "text/html");
      response.end("<title>in</title><script>localStorage.setItem(\"who\", \"alice\")</script>");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>${signedIn ? "signed in as alice" : "signed out"}</title>`);
  }).listen('$site_port', "127.0.0.1");
  // It ends by itself as well: the signal goes to what entered the namespace, not to it.
  setTimeout(() => process.exit(0), 600000).unref;
' >/dev/null 2>&1 &
site_pid=$!

default=$(api "$admin" GET /api/admin/tenants | jq -r '.data[] | select(.displayName == "default") | .id')
team=$(api "$admin" POST /api/admin/tenants '{"displayName":"Team"}' | jq -r .id)
gone=$(api "$admin" POST /api/admin/tenants '{"displayName":"Gone"}' | jq -r .id)
api "$admin" DELETE /api/admin/tenants/"$gone" >/dev/null

alice=$(api "$admin" POST /api/admin/users \
  '{"email":"alice@example.com","displayName":"Alice","isSystemAdmin":true,"createPersonalTenant":true}' | jq -r .id)
bob=$(api "$admin" POST /api/admin/users \
  '{"email":"bob@example.com","displayName":"Bob","isSystemAdmin":false}' | jq -r .id)
carol=$(api "$admin" POST /api/admin/users \
  '{"email":"carol@example.com","displayName":"Carol","isSystemAdmin":false}' | jq -r .id)
api "$admin" DELETE /api/admin/users/"$carol" >/dev/null
api "$admin" PUT /api/admin/tenants/"$team"/memberships/"$alice" \
  '{"scopes":["sessions:read","sessions:write","snapshots:read","snapshots:write","tenant:write"]}' >/dev/null
api "$admin" PUT /api/admin/tenants/"$team"/memberships/"$bob" \
  '{"scopes":["sessions:read","snapshots:read"]}' >/dev/null

tenant_token() { # tenant name scopes [more]
  api "$admin" POST /api/admin/tokens \
    '{"authorityType":"tenant","tenantId":"'"$1"'","name":"'"$2"'","scopes":'"$3${4:+,$4}"'}'
}
tenant_token "$team" ci '["sessions:write","snapshots:read","tenant:write"]' >/dev/null
revoked=$(tenant_token "$team" old '["sessions:read"]' | jq -r .token.id)
api "$admin" POST /api/admin/tokens/"$revoked"/revoke >/dev/null
tenant_token "$default" default-reader '["sessions:read"]' '"expiresAt":"2099-01-01T00:00:00Z"' >/dev/null

# The browser that signs in, and the snapshot of it.
session=$(api "$admin" POST /api/sessions \
  '{"browser":{"channel":"chromium"},"label":"signing in","tags":{"purpose":"fixture"},
    "initialTargets":[{"url":"http://127.0.0.1:'$site_port'/login"}]}' "$team" | jq -r .session.id)
signed_in=no
for _ in $(seq 1 60); do
  if api "$admin" GET /sessions/"$session"/browser/status '' "$team" 2>/dev/null \
    | jq -e '.pages[]? | select(.title == "in")' >/dev/null; then
    signed_in=yes
    break
  fi
  sleep 1
done
if [ "$signed_in" = no ]; then
  echo "the browser did not get to the site:" >&2
  api "$admin" GET /sessions/"$session"/browser/status '' "$team" >&2 || true
  exit 1
fi
# Chromium writes its cookies down a while after it takes them.
sleep 35
api "$admin" POST /api/sessions/"$session"/suspend '' "$team" >/dev/null
snapshot=$(api "$admin" POST /api/sessions/"$session"/promote \
  '{"name":"signed-in","description":"Alice, signed in to the site","tags":{"site":"local"}}' "$team" \
  | jq -r .snapshot.id)
tenant_token "$team" one-snapshot '["snapshots:read"]' \
  '"resourceMode":"allowlist","resourceGrants":[{"resourceType":"snapshot","resourceId":"'"$snapshot"'"}]' >/dev/null
# A snapshot that was deleted, and a session that is left suspended.
api "$admin" POST /api/sessions/"$session"/promote '{"name":"dropped"}' "$team" >/dev/null
api "$admin" DELETE /api/snapshots/dropped '' "$team" >/dev/null

podman stop "$name" >/dev/null
# As whoever unpacks it: v1's own user is nobody outside its container.
volume=$(podman volume inspect -f '{{.Mountpoint}}' "$name")
podman unshare tar --owner=0 --group=0 -C "$volume" -cf - aperture.db .aperture-root snapshots \
  | gzip -9n > "$here/v1.tar.gz"
ls -la "$here/v1.tar.gz"
