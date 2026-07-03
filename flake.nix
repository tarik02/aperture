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

          postInstall = ''
            mkdir -p $out/lib/systemd/user
            cp ${./packaging/systemd-user}/*.service $out/lib/systemd/user/
            cp ${./packaging/systemd-user}/*.timer $out/lib/systemd/user/ 2>/dev/null || true
            cp ${./packaging/systemd-user}/*.socket $out/lib/systemd/user/ 2>/dev/null || true

            substituteInPlace $out/lib/systemd/user/browser-session@.service \
              --replace-fail '@browserSessionWrapper@' $out/bin/browser-session-wrapper

            mkdir -p $out/share/aperture/traefik
            cp ${./packaging/traefik/static.yaml.template} $out/share/aperture/traefik/

            mkdir -p $out/share/aperture/sudoers
            cp ${./packaging/sudoers/aperture-mount-helpers} $out/share/aperture/sudoers/aperture-mount-helpers
            substituteInPlace $out/share/aperture/sudoers/aperture-mount-helpers \
              --replace-fail '@mountSessionHelper@' $out/bin/aperture-mount-session \
              --replace-fail '@unmountSessionHelper@' $out/bin/aperture-unmount-session
          '';

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
      }) // {
      nixosModules.aperture = import ./packaging/nix/module.nix { inherit self; };
    };
}
