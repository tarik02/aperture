# Everything on one machine: the control plane with its database, the proxy, and a node.
{ config, lib, ... }:
let
  cfg = config.services.aperture.standalone;
in
{
  options.services.aperture.standalone = {
    enable = lib.mkEnableOption "a whole Aperture deployment on this machine";
  };

  config = lib.mkIf cfg.enable {
    services.aperture = {
      keys.enable = true;
      control.enable = true;
      proxy.enable = true;
      node.enable = true;
    };
  };
}
