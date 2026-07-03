{
  description = "aperture chromium session supervisor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        aperture = (pkgs.buildGoModule {
          pname = "aperture";
          version = "0.0.1";
          src = ./.;
          vendorHash = "sha256-nrFXv97QqRosUd5uIgmnojwj9nHbhDP5HpavT6/09U8=";

          subPackages = [
            "cmd/aperture"
            "cmd/aperture-mount-session"
            "cmd/aperture-unmount-session"
            "cmd/browser-session-wrapper"
          ];

          doCheck = true;

          meta = with pkgs.lib; {
            description = "chromium session supervisor";
            license = licenses.mit;
          };
        }).overrideAttrs (oldAttrs: {
          checkPhase = ''
            runHook preCheck
            go test ./...
            runHook postCheck
          '';
        });
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            go
            gopls
            sqlite
            traefik
            chromium
            bubblewrap
          ];
        };

        packages.default = aperture;
        packages.aperture = aperture;

        checks.default = aperture;
      });
}
