# The control plane: accounts, nodes, where sessions run, and the console.
{ packagesFor }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.aperture.control;
  keys = config.services.aperture.keys;
  fromKeys = name: "${keys.directory}/${name}";
in
{
  options.services.aperture.control = {
    enable = lib.mkEnableOption "the Aperture control plane";
    package = lib.mkOption {
      type = lib.types.package;
      default = (packagesFor pkgs).aperture-control;
      defaultText = lib.literalExpression "aperture.packages.\${system}.aperture-control";
      description = "The control plane. It serves the console it was built with.";
    };
    listenHost = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "The address it listens on. A proxy stands before it for anyone outside.";
    };
    listenPort = lib.mkOption {
      type = lib.types.port;
      default = 7800;
    };
    publicUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "https://aperture.example";
      description = "Where people reach it from outside. Signing in takes requests from pages of that origin alone.";
    };
    internalUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://10.0.0.2:7800";
      description = "Where the proxy reaches it, when that is not the address it listens on.";
    };
    database = {
      createLocally = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run PostgreSQL on this machine, with a database of the control plane's own.";
      };
      url = lib.mkOption {
        type = lib.types.str;
        default = "postgres://aperture-control@localhost/aperture-control?host=/run/postgresql";
        description = "The database. A password in it ends up in the Nix store: prefer a socket, as the default is.";
      };
    };
    masterKeyFile = lib.mkOption {
      type = lib.types.path;
      default = fromKeys "master.key";
      description = "At least 32 bytes nobody guesses. What the control plane has to read again is sealed with it, so it stays the same.";
    };
    ticketKeyFile = lib.mkOption {
      type = lib.types.path;
      default = fromKeys "ticket.pem";
      description = "The Ed25519 private key tickets are signed with: PKCS#8, as PEM. Nodes are given its public key.";
    };
    bootstrapTokenFile = lib.mkOption {
      type = lib.types.path;
      default = fromKeys "bootstrap-token";
      description = "A token that does what an admin does, for making the first accounts.";
    };
    proxyTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = fromKeys "proxy-token";
      description = "A token with which the proxy reads its routes, and does nothing else.";
    };
    registrationTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = fromKeys "registration-token";
      description = "A registration token that is good without being made, for nodes set up together with the control plane.";
    };
    sso = {
      providers = lib.mkOption {
        default = { };
        description = ''
          The OpenID Connect providers people sign in through beside their passwords, by
          what each is known by in addresses. A provider is told to send people back to
          `<publicUrl>/api/auth/callback/<name>`. An admin adds providers in the console
          as well, under "Sign-in providers", while the control plane runs; those named
          here are shown there and changed here alone, and where both know one by the
          same name, the one named here is used.
        '';
        example = lib.literalExpression ''
          {
            company = {
              name = "Company";
              issuer = "https://id.example.com";
              clientId = "aperture";
              clientSecretFile = "/run/secrets/aperture-oidc";
            };
          }
        '';
        type = lib.types.attrsOf (
          lib.types.submodule (
            { name, ... }:
            {
              options = {
                name = lib.mkOption {
                  type = lib.types.str;
                  default = name;
                  description = "What the page that signs people in calls it.";
                };
                issuer = lib.mkOption {
                  type = lib.types.nullOr lib.types.str;
                  default = null;
                  description = "Its issuer, below which its discovery document is.";
                };
                discoveryUrl = lib.mkOption {
                  type = lib.types.nullOr lib.types.str;
                  default = null;
                  description = "Its discovery document, where that is not below the issuer.";
                };
                clientId = lib.mkOption { type = lib.types.str; };
                clientSecretFile = lib.mkOption {
                  type = lib.types.path;
                  description = "A file with the client secret, which the control plane's user reads.";
                };
              };
            }
          )
        );
      };
      provision = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Make whoever one of the providers named here vouches for a person when they first sign in. Without, they sign in only the people an admin made. A provider added in the console says this of itself.";
      };
      domains = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "example.com" ];
        description = "The domains of the email addresses people are made for so by the providers named here; any, where none is named. A provider added in the console names its own.";
      };
    };
    eventsKeep = lib.mkOption {
      type = lib.types.str;
      default = "90 days";
      example = "1 year";
      description = "How long an event is kept before it is forgotten: what was done by whom, as an admin reads it.";
    };
    metrics = {
      enable = lib.mkEnableOption "Prometheus metrics of the control plane, at `/metrics` on an address of their own";
      listen = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1:9465";
        description = "Where the metrics are served, as `host:port` or `[host]:port`: another port than `listenPort`, and than a node's metrics on the same machine. The endpoint has no authentication: keep it on loopback unless Prometheus runs on another machine, and then let only that machine reach it.";
      };
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "More of its environment, such as APERTURE_CONTROL_NODE_SILENT_AFTER.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.mapAttrsToList (id: provider: {
      assertion = provider.issuer != null || provider.discoveryUrl != null;
      message = "services.aperture.control.sso.providers.${id} names neither its issuer nor its discovery document.";
    }) cfg.sso.providers;

    users.users.aperture-control = {
      isSystemUser = true;
      group = "aperture-control";
    };
    users.groups.aperture-control = { };

    services.postgresql = lib.mkIf cfg.database.createLocally {
      enable = true;
      ensureDatabases = [ "aperture-control" ];
      ensureUsers = [
        {
          name = "aperture-control";
          ensureDBOwnership = true;
        }
      ];
    };

    systemd.services.aperture-control = {
      description = "Aperture control plane";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "aperture-keys.service"
      ]
      ++ lib.optional cfg.database.createLocally "postgresql.target";
      requires = lib.optional cfg.database.createLocally "postgresql.target";
      environment = {
        APERTURE_CONTROL_DATABASE_URL = cfg.database.url;
        APERTURE_CONTROL_LISTEN_HOST = cfg.listenHost;
        APERTURE_CONTROL_LISTEN_PORT = toString cfg.listenPort;
        APERTURE_CONTROL_MASTER_KEY = cfg.masterKeyFile;
        APERTURE_CONTROL_TICKET_KEY = cfg.ticketKeyFile;
        APERTURE_CONTROL_BOOTSTRAP_TOKEN_FILE = cfg.bootstrapTokenFile;
        APERTURE_CONTROL_EVENTS_KEEP = cfg.eventsKeep;
      }
      // lib.optionalAttrs (cfg.publicUrl != null) { APERTURE_CONTROL_PUBLIC_URL = cfg.publicUrl; }
      // lib.optionalAttrs (cfg.internalUrl != null) { APERTURE_CONTROL_INTERNAL_URL = cfg.internalUrl; }
      // lib.optionalAttrs cfg.metrics.enable { APERTURE_CONTROL_METRICS_LISTEN = cfg.metrics.listen; }
      // lib.optionalAttrs (cfg.proxyTokenFile != null) {
        APERTURE_CONTROL_PROXY_TOKEN_FILE = cfg.proxyTokenFile;
      }
      // lib.optionalAttrs (cfg.registrationTokenFile != null) {
        APERTURE_CONTROL_REGISTRATION_TOKEN_FILE = cfg.registrationTokenFile;
      }
      // lib.optionalAttrs (cfg.sso.providers != { }) {
        APERTURE_CONTROL_SSO_PROVIDERS = builtins.toJSON (
          lib.mapAttrsToList (
            id: provider:
            {
              inherit id;
              inherit (provider) name clientId clientSecretFile;
            }
            // lib.optionalAttrs (provider.issuer != null) { inherit (provider) issuer; }
            // lib.optionalAttrs (provider.discoveryUrl != null) { inherit (provider) discoveryUrl; }
          ) cfg.sso.providers
        );
        APERTURE_CONTROL_SSO_PROVISION = lib.boolToString cfg.sso.provision;
        APERTURE_CONTROL_SSO_DOMAINS = lib.concatStringsSep "," cfg.sso.domains;
      }
      // cfg.environment;
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = "aperture-control";
        Group = "aperture-control";
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
