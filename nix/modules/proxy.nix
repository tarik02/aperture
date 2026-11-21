# The proxy before the control plane and its nodes: a Traefik that reads its routes from
# the control plane, and asks it whether each request to a session may pass.
{ packagesFor }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.aperture.proxy;
  keys = config.services.aperture.keys;
in
{
  options.services.aperture.proxy = {
    enable = lib.mkEnableOption "the proxy before the Aperture control plane and its nodes";
    package = lib.mkPackageOption pkgs "traefik" { };
    address = lib.mkOption {
      type = lib.types.str;
      default = ":80";
      description = "Where it listens for everyone. It speaks no TLS by itself yet: put what does before it, or add it with `environment`.";
    };
    controlUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:7800";
      description = "Where it reaches the control plane.";
    };
    pollInterval = lib.mkOption {
      type = lib.types.str;
      default = "2s";
      description = "How often it asks for its routes: a node that registers is routed to this soon after.";
    };
    tokenEnvironmentFile = lib.mkOption {
      type = lib.types.path;
      default = "${keys.directory}/proxy.env";
      description = "A file that sets TRAEFIK_PROVIDERS_HTTP_HEADERS_AUTHORIZATION to `Bearer` and the control plane's proxy token.";
    };
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "More of Traefik's static configuration, as its TRAEFIK_ variables.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.aperture-proxy = {
      isSystemUser = true;
      group = "aperture-proxy";
    };
    users.groups.aperture-proxy = { };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [
      (lib.toInt (lib.last (lib.splitString ":" cfg.address)))
    ];

    systemd.services.aperture-proxy = {
      description = "Proxy before Aperture";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "aperture-keys.service"
      ];
      # All of it from the environment: Traefik takes its static configuration from one
      # place, and the token is not for a file anyone reads.
      environment = {
        TRAEFIK_ENTRYPOINTS_WEB_ADDRESS = cfg.address;
        TRAEFIK_PROVIDERS_HTTP_ENDPOINT = "${cfg.controlUrl}/api/control/route/traefik";
        TRAEFIK_PROVIDERS_HTTP_POLLINTERVAL = cfg.pollInterval;
        TRAEFIK_GLOBAL_CHECKNEWVERSION = "false";
        TRAEFIK_GLOBAL_SENDANONYMOUSUSAGE = "false";
      }
      // cfg.environment;
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = cfg.tokenEnvironmentFile;
        User = "aperture-proxy";
        Group = "aperture-proxy";
        AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
        Restart = "on-failure";
        RestartSec = 2;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
      };
    };
  };
}
