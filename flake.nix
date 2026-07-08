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

        patchedWeston = pkgs.weston.overrideAttrs (oldAttrs: {
          patches = (oldAttrs.patches or [ ]) ++ [
            (builtins.toFile "weston-pipewire-reconnect-on-mode-switch.patch" ''
              diff --git a/libweston/compositor.c b/libweston/compositor.c
              index c7f4c0f3d..5a6c87c1a 100644
              --- a/libweston/compositor.c
              +++ b/libweston/compositor.c
              @@ -645 +645 @@ weston_output_mode_set_native(struct weston_output *output,
              -${"\t"}int mode_changed = 0, scale_changed = 0;
              +${"\t"}int mode_changed, scale_changed = 0;
              @@ -651,10 +651,13 @@ weston_output_mode_set_native(struct weston_output *output,
              -${"\t"}if (!output->original_mode) {
              -${"\t"}${"\t"}mode_changed = 1;
              -${"\t"}${"\t"}ret = output->switch_mode(output, mode);
              -${"\t"}${"\t"}if (ret < 0)
              -${"\t"}${"\t"}${"\t"}return ret;
              -${"\t"}${"\t"}if (output->current_scale != scale) {
              -${"\t"}${"\t"}${"\t"}scale_changed = 1;
              -${"\t"}${"\t"}${"\t"}output->current_scale = scale;
              -${"\t"}${"\t"}}
              -${"\t"}}
              +${"\t"}mode_changed = !output->current_mode ||
              +${"\t"}${"\t"}output->current_mode->width != mode->width ||
              +${"\t"}${"\t"}output->current_mode->height != mode->height ||
              +${"\t"}${"\t"}output->current_mode->refresh != mode->refresh;
              +${"\t"}if (mode_changed) {
              +${"\t"}${"\t"}ret = output->switch_mode(output, mode);
              +${"\t"}${"\t"}if (ret < 0)
              +${"\t"}${"\t"}${"\t"}return ret;
              +${"\t"}}
              +${"\t"}if (output->current_scale != scale) {
              +${"\t"}${"\t"}scale_changed = 1;
              +${"\t"}${"\t"}output->current_scale = scale;
              +${"\t"}}
              @@ -663 +666,4 @@ weston_output_mode_set_native(struct weston_output *output,
              -${"\t"}weston_output_copy_native_mode(output, mode);
              +${"\t"}if (output->current_mode)
              +${"\t"}${"\t"}weston_output_copy_native_mode(output, output->current_mode);
              +${"\t"}else
              +${"\t"}${"\t"}weston_output_copy_native_mode(output, mode);
              @@ -664,0 +671,2 @@ weston_output_mode_set_native(struct weston_output *output,
              +${"\t"}output->original_mode = NULL;
              +${"\t"}output->original_scale = 0;

              diff --git a/libweston/backend-pipewire/pipewire.c b/libweston/backend-pipewire/pipewire.c
              index 0a2bb1b2d..c1f4d87fa 100644
              --- a/libweston/backend-pipewire/pipewire.c
              +++ b/libweston/backend-pipewire/pipewire.c
              @@ -1161,0 +1162,2 @@ pipewire_switch_mode(struct weston_output *base, struct weston_mode *target_mode
              +${"\t"}pw_stream_disconnect(output->stream);
              +
              @@ -1174 +1176,6 @@ pipewire_switch_mode(struct weston_output *base, struct weston_mode *target_mode
              -${"\t"}return 0;
              +${"\t"}if (pipewire_output_connect(output) < 0) {
              +${"\t"}${"\t"}weston_log("Failed to reconnect PipeWire stream after mode switch\n");
              +${"\t"}${"\t"}return -1;
              +${"\t"}}
              +
              +${"\t"}return 0;
               }

               static int
            '')
          ];
        });

        agentBrowserBinary =
          if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then "agent-browser-linux-x64"
          else if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then "agent-browser-linux-arm64"
          else if pkgs.stdenv.hostPlatform.system == "x86_64-darwin" then "agent-browser-darwin-x64"
          else if pkgs.stdenv.hostPlatform.system == "aarch64-darwin" then "agent-browser-darwin-arm64"
          else throw "agent-browser is not packaged for ${pkgs.stdenv.hostPlatform.system}";

        agentBrowser = pkgs.stdenvNoCC.mkDerivation {
          pname = "agent-browser";
          version = "0.31.1";

          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/agent-browser/-/agent-browser-0.31.1.tgz";
            hash = "sha512-RjgfT0EsHe1oZQbwzUqJTPb7w3sU8DGbbAjMxLNI5dW1y0cc81TbVsqgjqQJmsy3GEbEcKe/ryARwmWGqJAXXQ==";
          };

          nativeBuildInputs = with pkgs; [
            makeWrapper
          ] ++ lib.optionals pkgs.stdenv.isLinux [
            patchelf
          ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/agent-browser $out/bin
            cp -R . $out/lib/agent-browser/
            chmod +x $out/lib/agent-browser/bin/${agentBrowserBinary}

            ${lib.optionalString pkgs.stdenv.isLinux ''
              patchelf \
                --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" \
                $out/lib/agent-browser/bin/${agentBrowserBinary}
            ''}

            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/agent-browser \
              --add-flags $out/lib/agent-browser/bin/agent-browser.js

            runHook postInstall
          '';
        };

        deployVersion =
          if builtins.pathExists ./.aperture-deploy-version
          then builtins.readFile ./.aperture-deploy-version
          else self.shortRev or self.dirtyShortRev or "0.0.1";

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
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            pnpm = pkgs.pnpm;
            fetcherVersion = 3;
            pnpmWorkspaces = [ "@aperture/web" ];
            hash = "sha256-M/L5eP8I5iGzwKoLCqQ2e9iXER8vN2qDKgUFVbK/X1g=";
          };

          nativeBuildInputs = with pkgs; [
            makeWrapper
            nodejs_22
            pnpm
            pnpmConfigHook
            pkg-config
          ];

          buildInputs = with pkgs; [
            libxkbcommon
            pixman
            wayland.dev
            patchedWeston
          ];

          env.CI = "true";
          env.CGO_ENABLED = "1";

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
            mkdir -p $out/lib/weston
            mkdir -p $TMPDIR/aperture-wayland-protocols
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner private-code \
              ${pkgs.wayland-protocols}/share/wayland-protocols/staging/fractional-scale/fractional-scale-v1.xml \
              $TMPDIR/aperture-wayland-protocols/fractional-scale-v1-protocol.c
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner server-header \
              ${pkgs.wayland-protocols}/share/wayland-protocols/staging/fractional-scale/fractional-scale-v1.xml \
              $TMPDIR/aperture-wayland-protocols/fractional-scale-v1-server-protocol.h
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner private-code \
              ${pkgs.wayland-protocols}/share/wayland-protocols/stable/viewporter/viewporter.xml \
              $TMPDIR/aperture-wayland-protocols/viewporter-protocol.c
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner server-header \
              ${pkgs.wayland-protocols}/share/wayland-protocols/stable/viewporter/viewporter.xml \
              $TMPDIR/aperture-wayland-protocols/viewporter-server-protocol.h
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner private-code \
              ${pkgs.wayland-protocols}/share/wayland-protocols/staging/cursor-shape/cursor-shape-v1.xml \
              $TMPDIR/aperture-wayland-protocols/cursor-shape-v1-protocol.c
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner server-header \
              ${pkgs.wayland-protocols}/share/wayland-protocols/staging/cursor-shape/cursor-shape-v1.xml \
              $TMPDIR/aperture-wayland-protocols/cursor-shape-v1-server-protocol.h
            ${pkgs.wayland-scanner.bin}/bin/wayland-scanner private-code \
              ${pkgs.wayland-protocols}/share/wayland-protocols/stable/tablet/tablet-v2.xml \
              $TMPDIR/aperture-wayland-protocols/tablet-v2-protocol.c
            $CC -shared -fPIC \
              -I$TMPDIR/aperture-wayland-protocols \
              native/weston-aperture-shell/aperture-weston-shell.c \
              $TMPDIR/aperture-wayland-protocols/fractional-scale-v1-protocol.c \
              $TMPDIR/aperture-wayland-protocols/viewporter-protocol.c \
              $TMPDIR/aperture-wayland-protocols/cursor-shape-v1-protocol.c \
              $TMPDIR/aperture-wayland-protocols/tablet-v2-protocol.c \
              -o $out/lib/weston/aperture-weston-shell.so \
              $(pkg-config --cflags --libs weston libweston-15 wayland-server pixman-1 xkbcommon)

            mkdir -p $out/lib/systemd/user
            cp ${./packaging/systemd-user}/*.service $out/lib/systemd/user/
            cp ${./packaging/systemd-user}/*.timer $out/lib/systemd/user/ 2>/dev/null || true
            cp ${./packaging/systemd-user}/*.socket $out/lib/systemd/user/ 2>/dev/null || true
            install -m 0644 ${builtins.toFile "aperture-template.service" ''
              [Unit]
              Description=Aperture Chromium session supervisor (%i)
              After=graphical-session.target
              PartOf=graphical-session.target

              [Service]
              Type=simple
              Environment=APERTURE_DEPLOY_BLUE_URL=http://127.0.0.1:28080
              Environment=APERTURE_DEPLOY_GREEN_URL=http://127.0.0.1:28082
              Environment=APERTURE_DEPLOY_VERSION=@deployVersion@
              EnvironmentFile=-%h/.config/aperture/aperture.env
              EnvironmentFile=-%t/aperture/api/%i.env
              Environment=APERTURE_DEPLOY_COLOR=%i
              ExecStart=@runtimeShell@ -c 'export PATH="@apertureBinDir@:/run/wrappers/bin:/run/current-system/sw/bin:''${HOME}/.nix-profile/bin:''${PATH}"; case "%i" in blue) export APERTURE_DEPLOY_COLOR=blue APERTURE_LISTEN_ADDRESS=127.0.0.1:28080 ;; green) export APERTURE_DEPLOY_COLOR=green APERTURE_LISTEN_ADDRESS=127.0.0.1:28082 ;; *) echo "invalid aperture deploy color: %i" >&2; exit 64 ;; esac; exec @apertureBin@ serve --config /etc/aperture/aperture.toml'
              Restart=on-failure
              RestartSec=5

              [Install]
              WantedBy=default.target
            ''} $out/lib/systemd/user/aperture@.service

            substituteInPlace $out/lib/systemd/user/browser-session@.service \
              --replace-fail '@browserSessionWrapper@' $out/bin/browser-session-wrapper
            substituteInPlace $out/lib/systemd/user/aperture.service \
              --replace-fail '@runtimeShell@' ${pkgs.runtimeShell}
            substituteInPlace $out/lib/systemd/user/aperture@.service \
              --replace-fail '@runtimeShell@' ${pkgs.runtimeShell} \
              --replace-fail '@apertureBinDir@' $out/bin \
              --replace-fail '@apertureBin@' $out/bin/aperture \
              --replace-fail '@deployVersion@' ${deployVersion}
            substituteInPlace $out/lib/systemd/user/aperture-gc.service \
              --replace-fail '@apertureBin@' $out/bin/aperture
            substituteInPlace $out/lib/systemd/user/aperture-traefik.service \
              --replace-fail '@runtimeShell@' ${pkgs.runtimeShell} \
              --replace-fail '@staticConfigTemplate@' $out/share/aperture/traefik/static.yaml.template \
              --replace-fail '@traefikBin@' ${pkgs.traefik}/bin/traefik

            wrapProgram $out/bin/browser-session-wrapper \
              --prefix PATH : ${lib.makeBinPath [
                pkgs.bubblewrap
                pkgs.gst_all_1.gstreamer
                patchedWeston
                pkgs.pipewire
                pkgs.wireplumber
              ]}

            mkdir -p $out/share/aperture/traefik
            cp ${./packaging/traefik/static.yaml.template} $out/share/aperture/traefik/static.yaml.template

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
            pkg-config
            sqlite
            traefik
            chromium
            ffmpeg
            bubblewrap
            libxkbcommon
            pixman
            wayland.dev
            patchedWeston
            agentBrowser
          ];
        };

        packages.default = aperture;
        packages.aperture = aperture;

        checks.default = aperture;
      }) // {
      nixosModules.aperture = import ./packaging/nix/module.nix { inherit self; };
    };
}
