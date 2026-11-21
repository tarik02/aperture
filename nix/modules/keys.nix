# Makes the secrets the parts of a deployment share, once, on the machine itself: for a
# machine that has all the parts, or for trying things out. Where secrets are handed to
# machines some other way, each part is given its files instead and this stays off.
{ packagesFor }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.aperture.keys;
  # A file is its user's alone, or also its group's where another part reads it; a user
  # that is not on this machine has no file made for it.
  script = pkgs.writeShellScript "aperture-keys" ''
    set -euo pipefail
    umask 077
    cd ${cfg.directory}

    secret() { ${lib.getExe pkgs.openssl} rand -base64 32 | tr -d '\n=' | tr '+/' '-_'; }
    made() { [ -s "$1" ] || "''${@:2}" > "$1.new" && [ -s "$1" ] || mv "$1.new" "$1"; }
    owned() {
      local file=$1 owner=$2 group=$3 mode=$4
      id -u "$owner" > /dev/null 2>&1 || owner=root
      getent group "$group" > /dev/null 2>&1 || group=root
      chown "$owner:$group" "$file"
      chmod "$mode" "$file"
    }

    made master.key secret
    made bootstrap-token secret
    made registration-token secret
    made proxy-token secret
    made ticket.pem ${lib.getExe pkgs.openssl} genpkey -algorithm ed25519
    ${lib.getExe pkgs.openssl} pkey -in ticket.pem -pubout -out ticket.pub.pem
    # Traefik takes the header its provider sends from its environment.
    printf 'TRAEFIK_PROVIDERS_HTTP_HEADERS_AUTHORIZATION=Bearer %s\n' "$(cat proxy-token)" > proxy.env

    owned master.key aperture-control root 0400
    owned bootstrap-token aperture-control root 0400
    owned ticket.pem aperture-control root 0400
    owned ticket.pub.pem root root 0444
    owned registration-token aperture-node aperture-control 0440
    owned proxy-token aperture-control root 0400
    owned proxy.env aperture-proxy root 0400
  '';
in
{
  options.services.aperture.keys = {
    enable = lib.mkEnableOption "making the secrets of an Aperture deployment on this machine";
    directory = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/aperture-keys";
      description = "Where the secrets are kept. Each file is readable by the part that needs it.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules = [ "d ${cfg.directory} 0755 root root -" ];
    systemd.services.aperture-keys = {
      description = "Secrets of the Aperture deployment";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-tmpfiles-setup.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = script;
      };
    };
  };
}
