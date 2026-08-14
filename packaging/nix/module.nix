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
      )
  );
  path =
    lib.makeBinPath ([ aperture ] ++ cfg.extraPath) + ":/run/wrappers/bin:/run/current-system/sw/bin";
  environmentFiles = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
  rolloutExtraEnvironmentJSON = pkgs.writeText "aperture-rollout-extra-environment.json" (
    builtins.toJSON (map (name: {
      inherit name;
      value = cfg.extraEnvironment.${name};
    }) (lib.attrNames cfg.extraEnvironment))
  );
  rolloutEnvironmentProperties = lib.optionalString (cfg.environmentFile != null)
    (lib.escapeShellArg "--property=EnvironmentFile=${cfg.environmentFile}");
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
      pkgs.util-linux
    ];
    text = ''
      aperture_cli() {
        ${aperture}/bin/aperture "$@"
      }
      load_rollout_environment() {
        local env_dump
        env_dump="$(mktemp)"
        if ! jq -j '.[] | .name, "\u0000", .value, "\u0000"' ${lib.escapeShellArg rolloutExtraEnvironmentJSON} >"$env_dump"; then
          rm -f "$env_dump"
          return 1
        fi
        while IFS= read -r -d "" env_name && IFS= read -r -d "" env_value; do
          printf -v "$env_name" '%s' "$env_value"
          declare -gx "$env_name"
        done <"$env_dump"
        rm -f "$env_dump"
        ${lib.optionalString (cfg.environmentFile != null) ''
          env_dump="$(mktemp)"
          if ! systemd-run --user --wait --pipe --quiet ${rolloutEnvironmentProperties} env -0 >"$env_dump"; then
            rm -f "$env_dump"
            return 1
          fi
          while IFS= read -r -d "" env_assignment; do
            env_name="''${env_assignment%%=*}"
            env_value="''${env_assignment#*=}"
            printf -v "$env_name" '%s' "$env_value"
            declare -gx "$env_name"
          done <"$env_dump"
          rm -f "$env_dump"
        ''}
      }
      load_rollout_environment
      effective_version="''${APERTURE_DEPLOY_VERSION:-${deployVersion}}"

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
      stop_instance() {
        local color="$1"
        local stop_status=0
        systemctl --user stop "aperture@$color.service" || stop_status=$?
        [[ "$stop_status" == 0 || "$stop_status" == 5 ]]
      }
      lock_held=false
      ensure_deploy_lock_anchor() {
        local lock_path="$state_path.lock"
        local anchor_path="$lock_path.anchor"
        if [[ ! -e "$lock_path" && -e "$anchor_path" ]]; then
          ln "$anchor_path" "$lock_path" || [[ -e "$lock_path" ]]
        fi
        if [[ ! -e "$lock_path" ]]; then
          : >"$lock_path"
        fi
        if [[ ! -e "$anchor_path" ]]; then
          ln "$lock_path" "$anchor_path" || [[ -e "$anchor_path" ]]
        fi
        [[ "$(stat -c '%d:%i' "$lock_path")" == "$(stat -c '%d:%i' "$anchor_path")" ]]
      }
      acquire_deploy_lock() {
        ensure_deploy_lock_anchor
        exec {deploy_lock_fd}<>"$state_path.lock.anchor"
        flock "$deploy_lock_fd"
        export APERTURE_DEPLOY_LOCK_FD="$deploy_lock_fd"
        lock_held=true
      }
      release_deploy_lock() {
        if [[ "$lock_held" == true ]]; then
          local close_status=0
          exec {deploy_lock_fd}>&- || close_status=$?
          unset APERTURE_DEPLOY_LOCK_FD
          lock_held=false
          return "$close_status"
        fi
      }

      state_path="$(aperture_cli deployment state path --config ${configFileArg})"
      export APERTURE_DEPLOY_STATE_PATH="$state_path"
      rollout_generation="$$-$(date +%s%N)"
      ownership_marker="$state_path.rollout-owner"
      acquire_deploy_lock
      printf '%s\n' "$rollout_generation" >"$ownership_marker"
      state="$(aperture_cli deployment state get --config ${configFileArg})"
      active="$(jq -r .activeColor <<<"$state")"
      active_version="$(jq -r .activeVersion <<<"$state")"
      active_generation="$(jq -r .updatedAt <<<"$state")"
      case "$active" in
        blue) candidate=green; candidate_url=${greenURL} ;;
        green) candidate=blue; candidate_url=${blueURL} ;;
        *) echo "invalid active deployment color: $active" >&2; exit 1 ;;
      esac
      export APERTURE_DEPLOY_COLOR="$candidate"
      release_deploy_lock

      switched=false
      candidate_generation=""
      candidate_version=""
      candidate_enabled=false
      active_disabled=false
      rollback() {
        status=$?
        if [[ "$status" == 0 ]]; then
          status=1
        fi
        rollback_error=0
        restoration_failed=false
        ownership_lost=false
        trap - ERR INT TERM EXIT
        if [[ "$lock_held" != true ]] && ! acquire_deploy_lock; then
          echo "rollback: failed to reacquire deployment lock" >&2
          rollback_error=1
          ownership_lost=true
        fi
        if [[ "$ownership_lost" != true ]] && ! current_state="$(aperture_cli deployment state get --config ${configFileArg})"; then
          echo "rollback: failed to read deployment state" >&2
          rollback_error=1
          ownership_lost=true
        fi
        if [[ "$ownership_lost" != true ]]; then
          if [[ "$switched" == true ]]; then
            if ! jq --exit-status --arg candidate "$candidate" --arg version "$candidate_version" --arg generation "$candidate_generation" \
              '.activeColor == $candidate and .activeVersion == $version and .updatedAt == $generation' <<<"$current_state" >/dev/null; then
              rollback_error=1
              ownership_lost=true
            fi
          elif ! jq --exit-status --arg active "$active" --arg version "$active_version" --arg generation "$active_generation" \
            '.activeColor == $active and .activeVersion == $version and .updatedAt == $generation' <<<"$current_state" >/dev/null; then
            rollback_error=1
            ownership_lost=true
          fi
        fi
        if [[ "$ownership_lost" != true ]]; then
          if ! marker_value="$(cat "$ownership_marker" 2>/dev/null)" || [[ "$marker_value" != "$rollout_generation" ]]; then
            echo "rollback: rollout-generation ownership was lost; leaving candidate untouched" >&2
            rollback_error=1
            ownership_lost=true
          fi
        fi
        if [[ "$ownership_lost" != true && "$switched" == true ]]; then
            export APERTURE_DEPLOY_COLOR="$active"
            if [[ "$active_disabled" == true ]] && ! enable_instance "$active"; then
              echo "rollback: failed to re-enable $active instance" >&2
              rollback_error=1
              restoration_failed=true
            fi
            if [[ "$active_disabled" == true ]] && ! systemctl --user start "aperture@$active.service"; then
              echo "rollback: failed to start $active service" >&2
              rollback_error=1
              restoration_failed=true
            fi
            if ! aperture_cli deployment state mark-active "$active" --version "$active_version" --config ${configFileArg} >/dev/null; then
              echo "rollback: failed to restore deployment state" >&2
              rollback_error=1
              restoration_failed=true
            fi
            if ! aperture_cli deployment edge write --config ${configFileArg}; then
              echo "rollback: failed to restore edge configuration" >&2
              rollback_error=1
              restoration_failed=true
            fi
        fi
        if [[ "$restoration_failed" == true ]]; then
          echo "rollback: restoration failed; leaving candidate running" >&2
          if ! release_deploy_lock; then
            echo "rollback: failed to release deployment lock" >&2
            rollback_error=1
          fi
          exit 1
        fi
        if [[ "$ownership_lost" == true ]]; then
          echo "rollback: deployment ownership was lost; leaving candidate untouched" >&2
          if ! release_deploy_lock; then
            echo "rollback: failed to release deployment lock" >&2
            rollback_error=1
          fi
          exit 1
        fi
        if [[ "$candidate_enabled" == true ]]; then
          if ! disable_instance "$candidate"; then
            echo "rollback: failed to disable candidate instance" >&2
            rollback_error=1
          fi
        fi
        if ! stop_instance "$candidate"; then
          echo "rollback: failed to stop candidate service" >&2
          rollback_error=1
        fi
        if ! release_deploy_lock; then
          echo "rollback: failed to release deployment lock" >&2
          rollback_error=1
        fi
        if [[ "$rollback_error" != 0 ]]; then
          status=1
        fi
        exit "$status"
      }
      trap rollback ERR INT TERM EXIT

      enable_instance "$active"
      disable_instance "$candidate"
      candidate_enabled=true
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
        echo "candidate $candidate did not become healthy" >&2
        exit 1
      fi

      enable_instance "$candidate"
      acquire_deploy_lock
      state="$(aperture_cli deployment state get --config ${configFileArg})"
      if [[ "$(jq -r .activeColor <<<"$state")" != "$active" ]]; then
        echo "deployment changed while candidate was starting" >&2
        exit 1
      fi
      if ! jq --exit-status --arg active "$active" --arg version "$active_version" --arg generation "$active_generation" \
        '.activeColor == $active and .activeVersion == $version and .updatedAt == $generation' <<<"$state" >/dev/null; then
        echo "deployment version or generation changed while candidate was starting" >&2
        exit 1
      fi
      if ! marker_value="$(cat "$ownership_marker" 2>/dev/null)" || [[ "$marker_value" != "$rollout_generation" ]]; then
        echo "rollout ownership changed while candidate was starting" >&2
        exit 1
      fi
      candidate_state="$(aperture_cli deployment state mark-active "$candidate" --version "$effective_version" --config ${configFileArg})"
      candidate_generation="$(jq -r .updatedAt <<<"$candidate_state")"
      candidate_version="$(jq -r .activeVersion <<<"$candidate_state")"
      switched=true
      aperture_cli deployment edge write --config ${configFileArg}
      sleep ${toString cfg.deployment.drainSeconds}
      active_disabled=true
      disable_instance "$active"
      stop_instance "$active"
      if marker_value="$(cat "$ownership_marker" 2>/dev/null)" && [[ "$marker_value" == "$rollout_generation" ]]; then
        rm -f "$ownership_marker"
      fi
      release_deploy_lock
      trap - ERR INT TERM EXIT
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
      default = [ self.packages.${pkgs.system}.agent-browser ];
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
