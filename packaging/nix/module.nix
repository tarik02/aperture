{ self }:
{
  config,
  options,
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
        browser_pid_namespace = true;
        browser_tools_default = "core,vision,network";
        tool_output_max_bytes = 16777216;
        signed_file_url_ttl = "15m";
        signed_file_url_max_ttl = "24h";
      }
      (
        lib.recursiveUpdate cfg.settings {
          store_root = cfg.storeRoot;
          cold_root = cfg.coldRoot;
          database_path = cfg.databasePath;
          runtime_root = cfg.runtimeRoot;
          listen_address = cfg.deployment.blueAddress;
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
        // lib.optionalAttrs cfg.metrics.enable {
          metrics_address = cfg.metrics.address;
          metrics_per_session = cfg.metrics.perSession;
        }
      )
  );
  path =
    lib.makeBinPath ([ aperture ] ++ cfg.extraPath) + ":/run/wrappers/bin:/run/current-system/sw/bin";
  gstreamerPluginPath = lib.makeSearchPath "lib/gstreamer-1.0" [
    pkgs.gst_all_1.gstreamer.out
    pkgs.gst_all_1.gst-plugins-base
    pkgs.gst_all_1.gst-plugins-good
    pkgs.gst_all_1.gst-plugins-bad
    pkgs.gst_all_1.gst-plugins-ugly
    pkgs.pipewire
  ];
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

      user_unit_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      wants_dir="$user_unit_dir/default.target.wants"
      enable_instance() {
        local color="$1"
        mkdir -p "$wants_dir"
        rm -f "$user_unit_dir/aperture@$color.service"
        ln -sfn /etc/systemd/user/aperture@.service \
          "$wants_dir/aperture@$color.service"
        systemctl --user daemon-reload
      }
      disable_instance() {
        local color="$1"
        rm -f \
          "$user_unit_dir/aperture@$color.service" \
          "$wants_dir/aperture@$color.service"
        systemctl --user daemon-reload
      }

      state="$(aperture_cli deployment state get --config ${configFileArg})"
      active="$(jq -r .activeColor <<<"$state")"
      case "$active" in
        blue) candidate=green; candidate_url=${greenURL} ;;
        green) candidate=blue; candidate_url=${blueURL} ;;
        *) echo "invalid active deployment color: $active" >&2; exit 1 ;;
      esac

      enable_instance "$active"
      disable_instance "$candidate"
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

      switched=false
      candidate_enabled=false
      active_disabled=false
      rollback() {
        status=$?
        trap - ERR
        if [[ "$active_disabled" == true ]]; then
          enable_instance "$active" || true
        fi
        if [[ "$switched" == true ]]; then
          systemctl --user start "aperture@$active.service" || true
          aperture_cli deployment state mark-active "$active" --config ${configFileArg} >/dev/null || true
          aperture_cli deployment edge write --config ${configFileArg} || true
        fi
        if [[ "$candidate_enabled" == true ]]; then
          disable_instance "$candidate" || true
        fi
        systemctl --user stop "aperture@$candidate.service" || true
        exit "$status"
      }
      trap rollback ERR

      candidate_enabled=true
      enable_instance "$candidate"
      aperture_cli deployment state mark-active "$candidate" --config ${configFileArg} >/dev/null
      switched=true
      aperture_cli deployment edge write --config ${configFileArg}
      sleep ${toString cfg.deployment.drainSeconds}
      active_disabled=true
      disable_instance "$active"
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
    createUser = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to create `user` as a normal user for Aperture: lingering, so its user manager runs without a
        login, in the `render` and `video` groups for GPU access, and with a locked password.
      '';
    };
    uid = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.unsigned;
      default = null;
      example = 1000;
      description = ''
        UID of the user created by `createUser`. Null lets NixOS pick one; `runtimeRoot` must then be set,
        because its default needs the UID at evaluation time.
      '';
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
      description = "Local root for session overlay state. overlayfs needs it on a local filesystem, not NFS.";
    };
    coldRoot = lib.mkOption {
      type = lib.types.str;
      default = cfg.storeRoot;
      defaultText = lib.literalExpression "config.services.aperture.storeRoot";
      description = ''
        Root for snapshots and session files. It may be on NFS v3 or later with a lock manager, exported without
        root squashing. When changed on an existing install, run `aperture storage migrate` while Aperture is stopped.
      '';
    };
    databasePath = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.storeRoot}/aperture.db";
      defaultText = lib.literalExpression ''"''${config.services.aperture.storeRoot}/aperture.db"'';
      description = "SQLite database path. Keep it on a local filesystem, not NFS.";
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
      default = self.packages.${pkgs.system}.aperture-chromium;
      description = "Chromium build with Aperture's font configuration.";
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
      autoRollout = {
        enable = lib.mkEnableOption "the aperture-deploy system unit, which starts Aperture when no color runs and runs `aperture-rollout` on activations that change it";
        triggers = lib.mkOption {
          type = lib.types.listOf lib.types.path;
          default = [ ];
          example = lib.literalExpression "[ ./secrets/aperture/oidc-client-secret ]";
          description = ''
            Further paths whose change rolls Aperture out, such as the sources of secret files it reads. A Nix
            path value is copied to the store, so a change of its content counts; a string path counts only
            when the path itself changes. An external `configFile` is not tracked unless it is listed here.
          '';
        };
      };
    };
    metrics = {
      enable = lib.mkEnableOption "the Prometheus metrics listener";
      address = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:9464";
        description = ''
          Address serving Prometheus metrics at `/metrics`. Only the active API color binds it, so it stays
          one scrape target across `aperture-rollout`. It must differ from the blue and green API addresses.
        '';
      };
      perSession = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Whether to export CPU, memory, task, and I/O usage of every running session, labeled with its session
          ID. The series count grows with the number of concurrently running sessions.
        '';
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
    webrtc = {
      enable = lib.mkEnableOption "WebRTC streaming through the patched Weston compositor and a GStreamer media producer, with PipeWire and defaults for the `webrtc_*` settings that `settings` can override";
      westonPackage = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.patched-weston;
        defaultText = lib.literalExpression "aperture.packages.\${system}.patched-weston";
        description = "Weston build with the Aperture shell and the PipeWire backend.";
      };
      ffmpegPackage = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.aperture-ffmpeg;
        defaultText = lib.literalExpression "aperture.packages.\${system}.aperture-ffmpeg";
        description = "FFmpeg used to edit recordings, as `recording_ffmpeg_executable`.";
      };
      advertisedIp = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "203.0.113.10";
        description = ''
          Address announced in WebRTC ICE candidates, as `webrtc_media_producer_advertised_ip`. Set it when
          clients reach the host through an address that is not on its interfaces, such as a public address
          forwarded to it. Null leaves the choice to Aperture.
        '';
      };
      udpPorts = {
        from = lib.mkOption {
          type = lib.types.port;
          default = 50000;
          description = "First UDP port for WebRTC media, as `webrtc_media_producer_udp_port_min`.";
        };
        to = lib.mkOption {
          type = lib.types.port;
          default = 50099;
          description = "Last UDP port for WebRTC media, as `webrtc_media_producer_udp_port_max`.";
        };
      };
      codec = lib.mkOption {
        type = lib.types.enum [
          "auto"
          "vp8"
          "h264-va"
        ];
        default = "h264-va";
        description = ''
          Video codec, as `webrtc_media_producer_codec`. `h264-va` encodes on the GPU through VA-API and needs a
          working VA-API driver; `vp8` encodes on the CPU.
        '';
      };
      openFirewall = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether to open the WebRTC UDP port range in the firewall.";
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
      {
        assertion = userUID != null || options.services.aperture.runtimeRoot.highestPrio < 1500;
        message = "services.aperture.runtimeRoot defaults to /run/user/<uid>/aperture; give services.aperture.user a fixed UID (services.aperture.uid with createUser) or set runtimeRoot.";
      }
      {
        assertion = !cfg.webrtc.enable || cfg.webrtc.udpPorts.from <= cfg.webrtc.udpPorts.to;
        message = "services.aperture.webrtc.udpPorts.from must not exceed services.aperture.webrtc.udpPorts.to.";
      }
      {
        assertion = !cfg.deployment.autoRollout.enable || userUID != null;
        message = "services.aperture.deployment.autoRollout needs a fixed UID for services.aperture.user (services.aperture.uid with createUser).";
      }
    ];
    users.users.${cfg.user} = lib.mkIf cfg.createUser {
      isNormalUser = true;
      uid = lib.mkIf (cfg.uid != null) cfg.uid;
      # Aperture runs as user units, which need the user manager without a login.
      linger = true;
      extraGroups = [
        "render"
        "video"
      ];
      hashedPassword = "!";
    };
    environment.systemPackages = [
      aperture
    ]
    ++ lib.optional cfg.deployment.rollout.enable rollout
    ++ lib.optionals cfg.webrtc.enable [
      cfg.webrtc.westonPackage
      pkgs.gst_all_1.gstreamer
    ];
    services.pipewire.enable = lib.mkIf cfg.webrtc.enable true;
    networking.firewall.allowedUDPPortRanges = lib.mkIf (cfg.webrtc.enable && cfg.webrtc.openFirewall) [
      cfg.webrtc.udpPorts
    ];
    services.aperture.extraEnvironment = lib.mkIf cfg.webrtc.enable {
      APERTURE_WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH = lib.mkDefault gstreamerPluginPath;
      GST_PLUGIN_SYSTEM_PATH_1_0 = lib.mkDefault gstreamerPluginPath;
    };
    services.aperture.settings = lib.mkIf cfg.webrtc.enable (
      lib.mapAttrs (_: lib.mkDefault) (
        {
          webrtc_compositor_enabled = true;
          webrtc_compositor_executable = lib.getExe' cfg.webrtc.westonPackage "weston";
          webrtc_compositor_backend = "pipewire";
          webrtc_compositor_renderer = "gl";
          webrtc_compositor_shell = "aperture";
          webrtc_compositor_width = 1280;
          webrtc_compositor_height = 720;
          webrtc_media_producer_enabled = true;
          webrtc_media_producer_gst_executable = lib.getExe' pkgs.gst_all_1.gstreamer "gst-launch-1.0";
          webrtc_media_producer_target = "weston.pipewire";
          webrtc_media_producer_codec = cfg.webrtc.codec;
          webrtc_media_producer_fps = 60;
          webrtc_media_producer_bitrate_kbps = 6000;
          webrtc_media_producer_keyframe_interval = 120;
          webrtc_media_producer_udp_port_min = cfg.webrtc.udpPorts.from;
          webrtc_media_producer_udp_port_max = cfg.webrtc.udpPorts.to;
          recording_ffmpeg_executable = lib.getExe' cfg.webrtc.ffmpegPackage "ffmpeg";
        }
        // lib.optionalAttrs (cfg.webrtc.advertisedIp != null) {
          webrtc_media_producer_advertised_ip = cfg.webrtc.advertisedIp;
        }
      )
    );
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
      # aperture-rollout replaces the running color; activation must not restart it under the edge.
      restartIfChanged = false;
      stopIfChanged = false;
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
      # A running session keeps its browser across activations and runs the new wrapper from its
      # next start; restarting it would lose its pages and recordings.
      restartIfChanged = false;
      stopIfChanged = false;
      serviceConfig = {
        Type = "simple";
        EnvironmentFile = "%t/aperture/sessions/%i.env";
        ExecStart = "${aperture}/bin/browser-session-wrapper";
        Restart = "no";
        KillMode = "mixed";
        TimeoutStopSec = 20;
      };
    };
    systemd.services.aperture-deploy =
      let
        userManager = "user@${toString userUID}.service";
        # Changes with the package, the generated configuration, the API unit, and every trigger.
        stamp = lib.concatStringsSep " " (
          [
            "${aperture}"
            "${rollout}"
            "${config.systemd.user.units."aperture@.service".unit}"
          ]
          ++ lib.optional (cfg.configFile == null) "${generatedConfig}"
          ++ map (path: "${path}") cfg.deployment.autoRollout.triggers
        );
        userUnits =
          lib.optional cfg.traefik.enable "aperture-traefik.service"
          ++ lib.optional cfg.gc.enable "aperture-gc.timer";
      in
      lib.mkIf cfg.deployment.autoRollout.enable {
        description = "Start or roll out Aperture";
        wantedBy = [ "multi-user.target" ];
        requires = [ userManager ];
        after = [ userManager ];
        restartIfChanged = true;
        environment = {
          XDG_RUNTIME_DIR = "/run/user/${toString userUID}";
          DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/${toString userUID}/bus";
        };
        path = [
          pkgs.coreutils
          pkgs.systemd
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = cfg.user;
          StateDirectory = "aperture-deploy";
        };
        script = ''
          stamp=${lib.escapeShellArg stamp}
          stamp_file="$STATE_DIRECTORY/deployed"
          wants="''${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/default.target.wants"

          running() {
            case "$(systemctl --user is-active "aperture@$1.service" || true)" in
              active | activating | reloading) return 0 ;;
              *) return 1 ;;
            esac
          }

          systemctl --user daemon-reload

          if ! running blue && ! running green; then
            # Keep the color the last rollout left enabled, so the edge and deployment state stay valid.
            color=blue
            if [[ -e "$wants/aperture@green.service" && ! -e "$wants/aperture@blue.service" ]]; then
              color=green
            fi
            echo "no running Aperture color, starting $color"
            mkdir -p "$wants"
            ln -sfn /etc/systemd/user/aperture@.service "$wants/aperture@$color.service"
            systemctl --user daemon-reload
            systemctl --user start "aperture@$color.service"
          elif [[ "$(cat "$stamp_file" 2>/dev/null || true)" != "$stamp" ]]; then
            ${rollout}/bin/aperture-rollout
          fi

          ${lib.optionalString (userUnits != [ ]) ''
            systemctl --user enable --now ${lib.escapeShellArgs userUnits}
          ''}
          printf '%s' "$stamp" >"$stamp_file"
        '';
      };
  };
}
