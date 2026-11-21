# A node: an executor that runs sessions on this machine and registers with a control plane.
{ packagesFor }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.aperture.node;
  keys = config.services.aperture.keys;
in
{
  options.services.aperture.node = {
    enable = lib.mkEnableOption "an Aperture node";
    package = lib.mkOption {
      type = lib.types.package;
      default = (packagesFor pkgs).aperture;
      defaultText = lib.literalExpression "aperture.packages.\${system}.aperture";
      description = "The executor and the runner it starts for each session.";
    };
    name = lib.mkOption {
      type = lib.types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "The node's name, which no other node of the control plane has.";
    };
    listen = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:7900";
      description = "Where the executor listens. The control plane and the proxy reach it there, and nobody else needs to.";
    };
    controlPlane = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:7800";
      description = "The control plane it registers with.";
    };
    internalUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://10.0.0.7:7900";
      description = "Where the control plane and the proxy reach it, when that is not the address it listens on.";
    };
    registrationTokenFile = lib.mkOption {
      type = lib.types.path;
      default = "${keys.directory}/registration-token";
      description = "A registration token of the control plane.";
    };
    ticketKeyFile = lib.mkOption {
      type = lib.types.path;
      default = "${keys.directory}/ticket.pub.pem";
      description = "The public key of the control plane's tickets, as PEM.";
    };
    rtcPorts = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "60000-60999";
      description = "The UDP ports sessions' video and sound use, for a firewall that opens only some. Any port by default. Clients reach them directly, not through the proxy.";
    };
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open `rtcPorts` in the firewall.";
    };
    features = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "sound"
        "uploads"
        "downloads"
        "recordings"
        "clipboard"
        "cdp"
        "mcp"
      ];
      description = "What its sessions offer at most.";
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "More of the executor's environment, such as APERTURE_SNAPSHOT_STORE.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.aperture-node = {
      isSystemUser = true;
      group = "aperture-node";
      home = "/var/lib/aperture-node";
    };
    users.groups.aperture-node = { };

    # A session draws its pages itself, with the machine's graphics where it has some and
    # in software where it has none: either way the drivers are the system's.
    hardware.graphics.enable = lib.mkDefault true;

    networking.firewall.allowedUDPPortRanges = lib.mkIf (cfg.openFirewall && cfg.rtcPorts != null) (
      let
        ends = map lib.toInt (lib.splitString "-" cfg.rtcPorts);
      in
      [
        {
          from = lib.head ends;
          to = lib.last ends;
        }
      ]
    );

    systemd.services.aperture-node = {
      description = "Aperture node";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "aperture-keys.service"
      ];
      environment = {
        HOME = "/var/lib/aperture-node";
        APERTURE_LISTEN = cfg.listen;
        APERTURE_DATA_DIR = "/var/lib/aperture-node";
        APERTURE_RUNTIME_DIR = "/run/aperture-node";
        APERTURE_NODE = cfg.name;
        APERTURE_CONTROL_PLANE = cfg.controlPlane;
        APERTURE_REGISTRATION_TOKEN_FILE = cfg.registrationTokenFile;
        APERTURE_TICKET_KEY = cfg.ticketKeyFile;
        APERTURE_FEATURES = lib.concatStringsSep "," cfg.features;
      }
      // lib.optionalAttrs (cfg.internalUrl != null) { APERTURE_INTERNAL_URL = cfg.internalUrl; }
      // lib.optionalAttrs (cfg.rtcPorts != null) { APERTURE_RTC_PORTS = cfg.rtcPorts; }
      // cfg.environment;
      serviceConfig = {
        ExecStart = lib.getExe' cfg.package "aperture-executor";
        User = "aperture-node";
        Group = "aperture-node";
        StateDirectory = "aperture-node";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "aperture-node";
        RuntimeDirectoryMode = "0700";
        Restart = "on-failure";
        RestartSec = 2;
        # Its sessions' runners and browsers end with it only when it is stopped for good:
        # an executor that starts again finds the sessions it left.
        KillMode = "process";
      };
    };
  };
}
