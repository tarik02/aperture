# NixOS modules for the parts of a deployment, one for each, and one that puts them all
# on a machine. Each takes the programs from this flake unless it is given others.
{ self }:
let
  packagesFor = pkgs: self.packages.${pkgs.stdenv.hostPlatform.system};
  part = file: { imports = [ (import file { inherit packagesFor; }) ]; };
in
rec {
  keys = part ./keys.nix;
  control = part ./control.nix;
  proxy = part ./proxy.nix;
  node = part ./node.nix;
  standalone = {
    imports = [
      keys
      control
      proxy
      node
      ./standalone.nix
    ];
  };
  default = standalone;
}
