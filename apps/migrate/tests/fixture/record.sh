#!/usr/bin/env bash
# Records the v1 installation the checks migrate: a real v1, run from its image on a volume
# of its own, with tenants, people, tokens, a snapshot of a browser that is signed in to a
# site, and sessions: one suspended, with a file, a recording and routing of its own, one
# of a personal tenant, and one that was running when v1 stopped. What it leaves is
# v1.tar.gz beside this file.
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
  local answer
  if ! answer=$(curl -sS --fail-with-body -X "$2" "$url$3" -H "Authorization: Bearer $1" \
    ${4:+-H 'Content-Type: application/json' -d "$4"} ${5:+-H "X-Aperture-Tenant-Id: $5"}); then
    echo "$answer <- $2 $3" >&2
    return 1
  fi
  printf '%s' "$answer"
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

# Until a page of the session has the title; gives the page's target.
page_titled() { # session title tenant
  for _ in $(seq 1 60); do
    if target=$(api "$admin" GET /sessions/"$1"/browser/status '' "$3" 2>/dev/null \
      | jq -er --arg title "$2" 'first(.pages[]? | select(.title == $title)) | .targetId'); then
      echo "$target"
      return 0
    fi
    sleep 1
  done
  echo "the browser did not get to a page titled $2:" >&2
  api "$admin" GET /sessions/"$1"/browser/status '' "$3" >&2 || true
  return 1
}

# The browser that signs in: it has routing of its own, a file and a recording, and is
# left suspended. The snapshot is of it.
session=$(api "$admin" POST /api/sessions \
  '{"browser":{"channel":"chromium"},"label":"signing in","tags":{"purpose":"fixture"},
    "initialTargets":[{"url":"http://127.0.0.1:'$site_port'/login"}],
    "proxy":{"upstreams":{"corp":{"url":"socks5://user:secret@proxy.invalid:1080"}},
      "rules":[{"match":"*.corp.test","via":"corp"},{"match":"blocked.test:443","via":"refuse"},
        {"match":"[2001:db8::1]:443","via":"refuse"}]}}' "$team" | jq -r .session.id)
target=$(page_titled "$session" in "$team")
printf 'kept from v1\n' > "$work/note.txt"
curl -sS --fail-with-body -X POST "$url/api/sessions/$session/files?directory=uploads" \
  -H "Authorization: Bearer $admin" -H "X-Aperture-Tenant-Id: $team" \
  -F "files=@$work/note.txt" >/dev/null
recording=$(api "$admin" POST /api/sessions/"$session"/recordings \
  '{"targetId":"'"$target"'","codec":"vp8"}' "$team" | jq -r .recordingId)
sleep 3
api "$admin" POST /api/sessions/"$session"/recordings/"$recording"/stop '' "$team" >/dev/null
for _ in $(seq 1 60); do
  api "$admin" GET /api/sessions/"$session"/recordings/"$recording" '' "$team" \
    | jq -e '.editing == false' >/dev/null && break
  sleep 1
done
# Chromium writes its cookies down a while after it takes them.
sleep 35
api "$admin" POST /api/sessions/"$session"/suspend '' "$team" >/dev/null
snapshot=$(api "$admin" POST /api/sessions/"$session"/promote \
  '{"name":"signed-in","description":"Alice, signed in to the site","tags":{"site":"local"}}' "$team" \
  | jq -r .snapshot.id)
tenant_token "$team" one-snapshot '["snapshots:read"]' \
  '"resourceMode":"allowlist","resourceGrants":[{"resourceType":"snapshot","resourceId":"'"$snapshot"'"}]' >/dev/null
# A snapshot that was deleted.
api "$admin" POST /api/sessions/"$session"/promote '{"name":"dropped"}' "$team" >/dev/null
api "$admin" DELETE /api/snapshots/dropped '' "$team" >/dev/null

# A session of a personal tenant, suspended. The tenant is hidden from administrators, so
# v1's own program tells of it and makes the token that works in it.
v1() { podman exec "$name" aperture-server --config /etc/aperture/aperture.toml admin "$@"; }
personal=$(v1 tenants list | sed -n "s/^tenant id=\([^ ]*\) .* owner_user_id=$alice\$/\1/p")
own_token=$(v1 tokens create --name alice-own --authority-type tenant --tenant-id "$personal" \
  --scopes sessions:read,sessions:write | sed -n '/shown once/{n;p;}')
own=$(api "$own_token" POST /api/sessions \
  '{"browser":{"channel":"chromium"},"label":"alice'"'"'s own",
    "initialTargets":[{"url":"http://127.0.0.1:'$site_port'/own"}]}' | jq -r .session.id)
for _ in $(seq 1 60); do
  api "$own_token" GET /sessions/"$own"/browser/status 2>/dev/null \
    | jq -e '.pages[]? | select(.title == "signed out")' >/dev/null && break
  sleep 1
done
api "$own_token" POST /api/sessions/"$own"/suspend >/dev/null

# A session created from the snapshot, with a second page, that runs when v1 stops: what
# it wrote is above the snapshot's profile.
running=$(api "$admin" POST /api/sessions \
  '{"browser":{"channel":"chromium"},"label":"left running","baseSnapshotName":"signed-in",
    "initialTargets":[{"url":"http://127.0.0.1:'$site_port'/first"},{"url":"http://127.0.0.1:'$site_port'/second"}]}' "$team" \
  | jq -r .session.id)
page_titled "$running" "signed in as alice" "$team" >/dev/null
# Chromium writes down which pages it has a while after it opens them.
sleep 35

podman stop "$name" >/dev/null
# As whoever unpacks it: v1's own user is nobody outside its container. What overlayfs
# keeps in a session's upper directory goes along: the attributes that say a directory
# hides what is below it, and the devices that say a file is gone. What a browser keeps to
# be faster is left out, as is what overlayfs works in.
volume=$(podman volume inspect -f '{{.Mountpoint}}' "$name")
podman unshare tar --owner=0 --group=0 --xattrs --xattrs-include='user.*' -C "$volume" \
  --exclude='sessions/*/*/*/cache' --exclude='sessions/*/*/*/work' --exclude='sessions/*/*/*/merged' \
  --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='GrShaderCache' \
  --exclude='ShaderCache' --exclude='GraphiteDawnCache' --exclude='component_crx_cache' \
  --exclude='extensions_crx_cache' --exclude='BrowserMetrics*' --exclude='Safe Browsing' \
  -cf - aperture.db .aperture-root snapshots sessions \
  | gzip -9n > "$here/v1.tar.gz"
ls -la "$here/v1.tar.gz"
