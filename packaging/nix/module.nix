{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.aperture;
  aperture = cfg.package;
  userHome = "/home/${cfg.user}";
  storeRoot = "${userHome}/.local/state/aperture";
  userUID = config.users.users.${cfg.user}.uid;
  runtimeRoot = "/run/user/${toString userUID}/aperture";
  configFile = "/etc/aperture/aperture.toml";
  deployVersion = self.shortRev or self.dirtyShortRev or "0.0.1";
  apiEntrypoint = pkgs.writeShellScript "aperture-api-entrypoint" ''
    case "$1" in
      blue)
        export APERTURE_DEPLOY_COLOR=blue
        export APERTURE_LISTEN_ADDRESS=127.0.0.1:28080
        ;;
      green)
        export APERTURE_DEPLOY_COLOR=green
        export APERTURE_LISTEN_ADDRESS=127.0.0.1:28082
        ;;
      *)
        echo "invalid aperture deploy color: $1" >&2
        exit 64
        ;;
    esac

    exec ${aperture}/bin/aperture serve --config ${configFile}
  '';
in
{
  options.services.aperture = {
    enable = lib.mkEnableOption "Aperture browser session supervisor (user systemd units and sudo helpers)";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.aperture;
      description = "Aperture package providing the supervisor, helpers, and unit templates.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      description = "Login user that owns Aperture state, browser sessions, and passwordless sudo mount helpers.";
    };

    externalBaseUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://browser.example.test";
      description = "Public base URL Traefik serves for API and CDP routes.";
    };

    chromiumPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.chromium;
      description = "Chromium build used for the configured browser channel.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.user != "";
        message = "services.aperture.user must be set to the desktop user that runs Aperture.";
      }
      {
        assertion = lib.hasAttr cfg.user config.users.users;
        message = "services.aperture.user must be defined in users.users so runtime paths can be derived.";
      }
    ];

    environment.systemPackages = [ aperture ];

    environment.etc."aperture/aperture.toml".text = ''
      store_root = "${storeRoot}"
      runtime_root = "${runtimeRoot}"
      artifact_root = "${storeRoot}/artifacts"
      traefik_dynamic_config_dir = "${runtimeRoot}/traefik/dynamic"
      external_base_url = "${cfg.externalBaseUrl}"
      deploy_state_path = "${storeRoot}/deployment-state.json"
      deploy_blue_url = "http://127.0.0.1:28080"
      deploy_green_url = "http://127.0.0.1:28082"
      deploy_version = "${deployVersion}"

      [channels.chromium]
      executable = "${cfg.chromiumPackage}/bin/chromium"
      default_args = []
    '';

    security.sudo.extraRules = [
      {
        users = [ cfg.user ];
        commands = [
          {
            command = "${aperture}/bin/aperture-mount-session";
            options = [ "NOPASSWD" ];
          }
          {
            command = "${aperture}/bin/aperture-unmount-session";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];

    systemd.user.services."aperture@" = {
      description = "Aperture Chromium session supervisor (%i)";
      after = [ "graphical-session.target" ];
      partOf = [ "graphical-session.target" ];
      environment = {
        APERTURE_DEPLOY_COLOR = "%i";
        APERTURE_DEPLOY_BLUE_URL = "http://127.0.0.1:28080";
        APERTURE_DEPLOY_GREEN_URL = "http://127.0.0.1:28082";
        APERTURE_DEPLOY_VERSION = deployVersion;
      };
      serviceConfig = {
        Type = "simple";
        ExecStart = "${apiEntrypoint} %i";
        Restart = "on-failure";
      };
    };

    systemd.user.timers.aperture-gc = {
      description = "Periodic Aperture garbage collection";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "hourly";
        Persistent = true;
        Unit = "aperture-gc.service";
      };
    };

    systemd.user.services.aperture-gc = {
      description = "Trigger Aperture garbage collection";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${aperture}/bin/aperture trigger gc --config ${configFile}";
      };
    };

    systemd.user.services."browser-session@" = {
      description = "Browser session %i";
      wantedBy = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        EnvironmentFile = "%t/aperture/sessions/%i.env";
        ExecStart = "${aperture}/bin/browser-session-wrapper";
        Restart = "no";
        KillMode = "mixed";
        TimeoutStopSec = 20;
      };
    };
  };
}
