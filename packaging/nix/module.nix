{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.aperture;
  aperture = cfg.package;
  userHome = "/home/${cfg.user}";
  userUID = config.users.users.${cfg.user}.uid;
  deployVersion = self.shortRev or self.dirtyShortRev or "0.0.1";
  configFile = if cfg.configFile == null then "/etc/aperture/aperture.toml" else cfg.configFile;
  configFileArg = lib.escapeShellArg configFile;
  blueURL = "http://${cfg.deployment.blueAddress}";
  greenURL = "http://${cfg.deployment.greenAddress}";
  toml = pkgs.formats.toml { };
  generatedConfig = toml.generate "aperture.toml" (
    lib.recursiveUpdate
      {
        mcp_enabled = true;
        agent_browser_tools_default = "core,tabs,mobile,network";
        agent_browser_idle_timeout = "5m";
        tool_output_max_bytes = 16777216;
        signed_file_url_ttl = "15m";
        signed_file_url_max_ttl = "24h";
      }
      (
        lib.recursiveUpdate cfg.settings {
          store_root = cfg.storeRoot;
          runtime_root = cfg.runtimeRoot;
          artifact_root = "${cfg.storeRoot}/artifacts";
          traefik_dynamic_config_dir = "${cfg.runtimeRoot}/traefik/dynamic";
          external_base_url = cfg.externalBaseUrl;
          deploy_state_path = "${cfg.storeRoot}/deployment-state.json";
          deploy_blue_url = blueURL;
          deploy_green_url = greenURL;
          deploy_version = deployVersion;
          channels.chromium = {
            executable = "${cfg.chromiumPackage}/bin/chromium";
            default_args = cfg.chromiumArgs;
          };
        }
      )
  );
  path =
    lib.makeBinPath ([ aperture ] ++ cfg.extraPath) + ":/run/wrappers/bin:/run/current-system/sw/bin";
  environmentFiles = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
  rolloutEnvironmentArgs = lib.concatStringsSep " \\\n          " (
    lib.optional (cfg.environmentFile != null) (
      lib.escapeShellArg "--property=EnvironmentFile=${cfg.environmentFile}"
    )
    ++ map (name: lib.escapeShellArg "--setenv=${name}=${cfg.extraEnvironment.${name}}") (
      lib.attrNames cfg.extraEnvironment
    )
  );
  apiEntrypoint = pkgs.writeShellScript "aperture-api-entrypoint" ''
    export PATH=${path}:$PATH

    case "$1" in
      blue)
        export APERTURE_DEPLOY_COLOR=blue
        export APERTURE_LISTEN_ADDRESS=${cfg.deployment.blueAddress}
        ;;
      green)
        export APERTURE_DEPLOY_COLOR=green
        export APERTURE_LISTEN_ADDRESS=${cfg.deployment.greenAddress}
        ;;
      *)
        echo "invalid aperture deploy color: $1" >&2
        exit 64
        ;;
    esac

    exec ${aperture}/bin/aperture serve --config ${configFileArg}
  '';
  traefikConfig = (pkgs.formats.yaml { }).generate "aperture-traefik.yaml" {
    entryPoints.web.address = cfg.traefik.entrypointAddress;
    providers.file = {
      directory = "${cfg.runtimeRoot}/traefik/dynamic";
      watch = true;
    };
  };
  rollout = pkgs.writeShellApplication {
    name = "aperture-rollout";
    runtimeInputs = [
      aperture
      pkgs.coreutils
      pkgs.curl
      pkgs.jq
      pkgs.systemd
    ];
    text = ''
      aperture_cli() {
        systemd-run --user --quiet --pipe --wait --collect --service-type=exec \
          ${rolloutEnvironmentArgs} \
          ${aperture}/bin/aperture "$@"
      }

      state="$(aperture_cli deployment state get --config ${configFileArg})"
      active="$(jq -r .activeColor <<<"$state")"
      case "$active" in
        blue) candidate=green; candidate_url=${greenURL} ;;
        green) candidate=blue; candidate_url=${blueURL} ;;
        *) echo "invalid active deployment color: $active" >&2; exit 1 ;;
      esac

      systemctl --user start "aperture@$candidate.service"
      ready=false
      for _ in $(seq 1 ${toString cfg.deployment.healthTimeoutSeconds}); do
        if curl --fail --silent --show-error "$candidate_url/api/health" |
          jq --exit-status --arg color "$candidate" '.status == "ok" and .color == $color' >/dev/null; then
          ready=true
          break
        fi
        sleep 1
      done
      if [[ "$ready" != true ]]; then
        systemctl --user stop "aperture@$candidate.service"
        echo "candidate $candidate did not become healthy" >&2
        exit 1
      fi

      user_unit_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      candidate_link="$user_unit_dir/default.target.wants/aperture@$candidate.service"
      active_link="$user_unit_dir/default.target.wants/aperture@$active.service"
      switched=false
      candidate_enabled=false
      active_disabled=false
      rollback() {
        status=$?
        trap - ERR
        if [[ "$active_disabled" == true ]]; then
          systemctl --user add-wants default.target "aperture@$active.service" || true
        fi
        if [[ "$switched" == true ]]; then
          systemctl --user start "aperture@$active.service" || true
          aperture_cli deployment state mark-active "$active" --config ${configFileArg} >/dev/null || true
          aperture_cli deployment edge write --config ${configFileArg} || true
        fi
        if [[ "$candidate_enabled" == true ]]; then
          rm -f "$candidate_link"
          systemctl --user daemon-reload || true
        fi
        systemctl --user stop "aperture@$candidate.service" || true
        exit "$status"
      }
      trap rollback ERR

      systemctl --user add-wants default.target "aperture@$candidate.service"
      candidate_enabled=true
      aperture_cli deployment state mark-active "$candidate" --config ${configFileArg} >/dev/null
      switched=true
      aperture_cli deployment edge write --config ${configFileArg}
      sleep ${toString cfg.deployment.drainSeconds}
      rm -f "$active_link"
      active_disabled=true
      systemctl --user daemon-reload
      systemctl --user stop "aperture@$active.service"
      trap - ERR
      echo "activated $candidate"
    '';
  };
in
{
  options.services.aperture = {
    enable = lib.mkEnableOption "Aperture browser session supervisor";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.aperture;
      description = "Aperture package providing the supervisor and helpers.";
    };
    user = lib.mkOption {
      type = lib.types.str;
      description = "Login user that owns Aperture state and browser sessions.";
    };
    externalBaseUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://browser.example.test";
      description = "Public base URL used for generated links.";
    };
    storeRoot = lib.mkOption {
      type = lib.types.str;
      default = "${userHome}/.local/state/aperture";
      defaultText = lib.literalExpression ''"/home/''${config.services.aperture.user}/.local/state/aperture"'';
      description = "Persistent Aperture state root.";
    };
    runtimeRoot = lib.mkOption {
      type = lib.types.str;
      default = "/run/user/${toString userUID}/aperture";
      defaultText = lib.literalExpression ''"/run/user/<uid>/aperture"'';
      description = "Ephemeral Aperture runtime root.";
    };
    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "External root-owned Aperture config file. Null generates /etc/aperture/aperture.toml.";
    };
    settings = lib.mkOption {
      type = toml.type;
      default = { };
      description = "Additional non-secret Aperture TOML settings.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/alice/.config/aperture/aperture.env";
      description = "Systemd environment file for credentials and settings outside the Nix store.";
    };
    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for Aperture services and deployment commands.";
    };
    extraPath = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional packages available to Aperture API services.";
    };
    chromiumPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.chromium;
      description = "Chromium build used for the default browser channel.";
    };
    chromiumArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Default arguments for the Chromium channel.";
    };
    deployment = {
      blueAddress = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:28080";
      };
      greenAddress = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:28082";
      };
      drainSeconds = lib.mkOption {
        type = lib.types.ints.unsigned;
        default = 30;
      };
      healthTimeoutSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 30;
      };
      rollout.enable = lib.mkEnableOption "the aperture-rollout blue-green deployment helper" // {
        default = true;
      };
    };
    gc = {
      enable = lib.mkEnableOption "periodic Aperture garbage collection" // {
        default = true;
      };
      interval = lib.mkOption {
        type = lib.types.str;
        default = "hourly";
      };
    };
    traefik = {
      enable = lib.mkEnableOption "the Aperture Traefik edge proxy";
      package = lib.mkOption {
        type = lib.types.package;
        default = pkgs.traefik;
      };
      entrypointAddress = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:28081";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.user != "";
        message = "services.aperture.user must be set.";
      }
      {
        assertion = lib.hasAttr cfg.user config.users.users;
        message = "services.aperture.user must reference a configured user.";
      }
    ];
    environment.systemPackages = [ aperture ] ++ lib.optional cfg.deployment.rollout.enable rollout;
    environment.etc."aperture/aperture.toml" = lib.mkIf (cfg.configFile == null) {
      source = generatedConfig;
    };
    security.sudo.extraRules = [
      {
        users = [ cfg.user ];
        commands =
          map
            (command: {
              inherit command;
              options = [ "NOPASSWD" ];
            })
            [
              "${aperture}/bin/aperture-mount-session"
              "${aperture}/bin/aperture-unmount-session"
            ];
      }
    ];
    systemd.user.services."aperture@" = {
      description = "Aperture Chromium session supervisor (%i)";
      unitConfig.ConditionUser = cfg.user;
      after = [ "graphical-session.target" ];
      partOf = [ "graphical-session.target" ];
      environment = {
        APERTURE_DEPLOY_COLOR = "%i";
        APERTURE_DEPLOY_BLUE_URL = blueURL;
        APERTURE_DEPLOY_GREEN_URL = greenURL;
        APERTURE_DEPLOY_VERSION = deployVersion;
      }
      // cfg.extraEnvironment;
      serviceConfig = {
        Type = "simple";
        ExecStart = "${apiEntrypoint} %i";
        EnvironmentFile = environmentFiles;
        Restart = "on-failure";
      };
    };
    systemd.user.timers.aperture-gc = lib.mkIf cfg.gc.enable {
      description = "Periodic Aperture garbage collection";
      unitConfig.ConditionUser = cfg.user;
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.gc.interval;
        Persistent = true;
        Unit = "aperture-gc.service";
      };
    };
    systemd.user.services.aperture-gc = lib.mkIf cfg.gc.enable {
      description = "Trigger Aperture garbage collection";
      unitConfig.ConditionUser = cfg.user;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${aperture}/bin/aperture trigger gc --config ${configFileArg}";
        EnvironmentFile = environmentFiles;
      };
    };
    systemd.user.services.aperture-traefik = lib.mkIf cfg.traefik.enable {
      description = "Traefik edge proxy for Aperture";
      unitConfig.ConditionUser = cfg.user;
      wantedBy = [ "default.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStartPre = "${pkgs.coreutils}/bin/install -d ${cfg.runtimeRoot}/traefik/dynamic";
        ExecStart = "${cfg.traefik.package}/bin/traefik --configFile=${traefikConfig}";
        Restart = "on-failure";
      };
    };
    systemd.user.services."browser-session@" = {
      description = "Browser session %i";
      unitConfig.ConditionUser = cfg.user;
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
