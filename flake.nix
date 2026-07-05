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
        lib = pkgs.lib;

        isPackageSourceExcluded = path:
          let
            root = (toString ./.) + "/";
            rel = lib.removePrefix root (toString path);
          in
          rel == "result"
          || rel == "node_modules"
          || lib.hasPrefix "node_modules/" rel
          || rel == "web/node_modules"
          || lib.hasPrefix "web/node_modules/" rel
          || rel == "web/dist"
          || lib.hasPrefix "web/dist/" rel
          || rel == "web/.output"
          || lib.hasPrefix "web/.output/" rel
          || rel == ".scaffold-tmp"
          || lib.hasPrefix ".scaffold-tmp/" rel
          || rel == "vendor"
          || lib.hasPrefix "vendor/" rel;

        src = lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            lib.cleanSourceFilter path type && !isPackageSourceExcluded path;
        };

        aperture = (pkgs.buildGoModule (finalAttrs: {
          pname = "aperture";
          version = "0.0.1";
          inherit src;
          vendorHash = "sha256-iqKAicw4N/AJnBJwV/y+zcGUMePJSGMBf3jme2jqIZg=";

          subPackages = [
            "cmd/aperture"
            "cmd/aperture-mount-session"
            "cmd/aperture-unmount-session"
            "cmd/browser-session-wrapper"
            "cmd/webrtc-media-producer"
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            pnpm = pkgs.pnpm;
            fetcherVersion = 3;
            pnpmWorkspaces = [ "@aperture/web" ];
            hash = "sha256-JTNh3d2eAdcYWb74Ez8d5q5vlhJ5WXFBVuVMRvubs70=";
          };

          nativeBuildInputs = with pkgs; [
            nodejs_22
            pnpm
            pnpmConfigHook
          ];

          env.CI = "true";

          preBuild = ''
            pnpm --filter @aperture/web build
            test -f web/dist/client/index.html
          '';

          # Vendor derivation only needs Go modules, not frontend dependencies.
          overrideModAttrs = oldAttrs: {
            nativeBuildInputs = builtins.filter (drv:
              drv != pkgs.pnpmConfigHook
              && drv != pkgs.pnpm
              && drv != pkgs.nodejs_22
            ) (oldAttrs.nativeBuildInputs or [ ]);
            preBuild = "";
            pnpmDeps = null;
          };

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
        })).overrideAttrs (oldAttrs: {
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
            nodejs_22
            pnpm
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
