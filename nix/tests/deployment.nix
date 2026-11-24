# One machine set up by the modules alone: an account is made with the bootstrap token,
# and a session of it is reached through the proxy.
{ self }:
{
  name = "aperture-deployment";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.default ];
      services.aperture.standalone.enable = true;
      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
      ];
      # A browser runs in it.
      virtualisation.memorySize = 4096;
      virtualisation.cores = 4;
      virtualisation.diskSize = 8192;
    };

  testScript = ''
    machine.wait_for_unit("aperture-keys.service")
    print(machine.succeed("ls -la /var/lib/aperture-keys"))
    machine.wait_for_unit("aperture-control.service", timeout=180)
    machine.wait_for_unit("aperture-node.service")
    machine.wait_for_unit("aperture-proxy.service")
    machine.wait_for_open_port(7800)
    machine.wait_for_open_port(80)

    with subtest("the control plane says that it serves, to anyone"):
        machine.wait_until_succeeds("curl -sf http://localhost:7800/api/control/health | jq -e '.status == \"ok\"'", timeout=60)

    api = "http://localhost/api/control"
    bootstrap = machine.succeed("cat /var/lib/aperture-keys/bootstrap-token").strip()

    def call(token, method, path, body=None):
        data = "" if body is None else f"-H 'Content-Type: application/json' -d '{body}'"
        return f"curl -sf -X {method} -H 'Authorization: Bearer {token}' {data} {api}{path}"

    with subtest("the console is served through the proxy"):
        # The proxy has its routes once it has asked for them.
        machine.wait_until_succeeds(
            "curl -sf http://localhost/ | grep -q '<title>Aperture</title>'", timeout=60
        )

    with subtest("the node registers itself, and the control plane reaches it"):
        machine.wait_until_succeeds(
            call(bootstrap, "GET", "/nodes") + " | jq -e '.[0].alive and .[0].offers != null'",
            timeout=120,
        )

    with subtest("the proxy's token reads the routes and does nothing else"):
        proxy = machine.succeed("cat /var/lib/aperture-keys/proxy-token").strip()
        machine.succeed(call(proxy, "GET", "/route/traefik") + " | jq -e '.http.routers | length >= 2'")
        machine.fail(call(proxy, "GET", "/nodes"))

    with subtest("a session of an account is reached through the proxy"):
        account = machine.succeed(
            call(bootstrap, "POST", "/accounts", '{"name":"ops"}') + " | jq -er .id"
        ).strip()
        token = machine.succeed(
            call(bootstrap, "POST", f"/accounts/{account}/tokens", '{"name":"check","scopes":["sessions:write"]}') + " | jq -er .token"
        ).strip()
        path = machine.succeed(call(token, "POST", "/sessions", "{}") + " | jq -er .path").strip()
        machine.wait_until_succeeds(
            f"curl -sf -H 'Authorization: Bearer {token}' http://localhost{path}/targets | jq -e 'length >= 1'",
            timeout=180,
        )
        machine.fail(f"curl -sf http://localhost{path}/targets")
  '';
}
