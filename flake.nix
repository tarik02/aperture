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

        goLatest = pkgs.go_1_26.overrideAttrs (_: {
          version = "1.26.5";
          src = pkgs.fetchurl {
            url = "https://go.dev/dl/go1.26.5.src.tar.gz";
            hash = "sha256-SVvkvIcXasVnOS5bQRar2YRm0z17SdQedkzMaXay3EI=";
          };
        });

        pnpmLatest = pkgs.pnpm.override {
          version = "11.13.0";
          hash = "sha256-hlx2vZERpFykH27u1AZ/8Ozf7p6sg6rSQXnIP/6+dZk=";
        };

        buildGoModule = pkgs.buildGoModule.override {
          go = goLatest;
        };

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
            (builtins.toFile "weston-pipewire-renegotiate-on-mode-switch.patch" ''
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
              index 0a2bb1b2d..e2d767537 100644
              --- a/libweston/backend-pipewire/pipewire.c
              +++ b/libweston/backend-pipewire/pipewire.c
              @@ -1149,4 +1149,9 @@ pipewire_switch_mode(struct weston_output *base, struct weston_mode *target_mode
               {
              +${"\t"}uint8_t buffer[1024];
              +${"\t"}struct spa_pod_builder builder =
              +${"\t"}${"\t"}SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
              +${"\t"}const struct spa_pod *params[2];
              +${"\t"}int i = 0;
               ${"\t"}struct pipewire_output *output = to_pipewire_output(base);
               ${"\t"}struct weston_mode *local_mode;
               ${"\t"}struct weston_size fb_size;
              @@ -1174,2 +1179,23 @@ pipewire_switch_mode(struct weston_output *base, struct weston_mode *target_mode
              -${"\t"}return 0;
              +${"\t"}if (pipewire_backend_has_dmabuf_allocator(output->backend)) {
              +${"\t"}${"\t"}uint64_t modifier[] = { DRM_FORMAT_MOD_LINEAR };
              +${"\t"}${"\t"}params[i++] = spa_pod_build_format(&builder,
              +${"\t"}${"\t"}${"\t"}${"\t"}${"\t"}   base->current_mode->width,
              +${"\t"}${"\t"}${"\t"}${"\t"}${"\t"}   base->current_mode->height,
              +${"\t"}${"\t"}${"\t"}${"\t"}${"\t"}   base->current_mode->refresh / 1000,
              +${"\t"}${"\t"}${"\t"}${"\t"}${"\t"}   output->pixel_format->format,
              +${"\t"}${"\t"}${"\t"}${"\t"}${"\t"}   modifier);
              +${"\t"}}
              +
              +${"\t"}params[i++] = spa_pod_build_format(&builder,
              +${"\t"}${"\t"}${"\t"}${"\t"}   base->current_mode->width,
              +${"\t"}${"\t"}${"\t"}${"\t"}   base->current_mode->height,
              +${"\t"}${"\t"}${"\t"}${"\t"}   base->current_mode->refresh / 1000,
              +${"\t"}${"\t"}${"\t"}${"\t"}   output->pixel_format->format, NULL);
              +
              +${"\t"}if (pw_stream_update_params(output->stream, params, i) < 0) {
              +${"\t"}${"\t"}weston_log("Failed to update PipeWire stream after mode switch\n");
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
          version = "0.31.2";

          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/agent-browser/-/agent-browser-0.31.2.tgz";
            hash = "sha512-TkqqlFIIs9XFR7GCX92syuWdbWy3pcGkTsBKk/oncofVfICmaMJHnAeXk2MciE1SEUonzRqVNUCnYCqcO8rqWA==";
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

        s6OverlayVersion = "3.2.3.1";
        s6OverlayArch =
          if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then {
            archive = "x86_64";
            hash = "sha256-7XL9s6vxlkctEhsCa+1jtG80Q1B70s5n32vRh/fU3Ao=";
          }
          else if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then {
            archive = "aarch64";
            hash = "sha256-x5tcx+XkBfbhrhRmqBYKyE0puGYU4eAf8PsR3IMv7hs=";
          }
          else null;

        s6OverlayNoarch = pkgs.fetchurl {
          url = "https://github.com/just-containers/s6-overlay/releases/download/v${s6OverlayVersion}/s6-overlay-noarch.tar.xz";
          hash = "sha256-Q9mdJm/v4yzcFRCWOqreshHMhFC2CvJ4F7ZK9FDJNL4=";
        };

        s6OverlayRootfs =
          if pkgs.stdenv.isLinux then
            pkgs.runCommand "s6-overlay-rootfs-${s6OverlayVersion}" {
              nativeBuildInputs = [ pkgs.gnutar pkgs.xz ];
            } ''
              mkdir -p $out
              tar -C $out --no-same-owner --no-same-permissions -Jxf ${s6OverlayNoarch}
              tar -C $out --no-same-owner --no-same-permissions -Jxf ${pkgs.fetchurl {
                url = "https://github.com/just-containers/s6-overlay/releases/download/v${s6OverlayVersion}/s6-overlay-${s6OverlayArch.archive}.tar.xz";
                hash = s6OverlayArch.hash;
              }}
            ''
          else
            null;

        deployVersion =
          if builtins.pathExists ./.aperture-deploy-version
          then builtins.readFile ./.aperture-deploy-version
          else self.shortRev or self.dirtyShortRev or "0.0.1";

        aperture = (buildGoModule (finalAttrs: {
          pname = "aperture";
          version = "0.0.1";
          inherit src;
          vendorHash = "sha256-hXAgH1j4B9G5luWf4PnU58hEqVCJOZNhdrnf/r9Yirc=";

          subPackages = [
            "cmd/aperture"
            "cmd/aperture-mount-session"
            "cmd/aperture-unmount-session"
            "cmd/browser-session-wrapper"
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            pnpm = pnpmLatest;
            fetcherVersion = 4;
            pnpmWorkspaces = [ "@aperture/web" ];
            hash = "sha256-qvsj4YLNMwY84NJ7hRCjonf4GEeB6xXwqsGWvIEMmTw=";
          };

          nativeBuildInputs = [
            pkgs.makeWrapper
            pkgs.nodejs_22
            pnpmLatest
            pkgs.pnpmConfigHook
            pkgs.pkg-config
          ];

          buildInputs = with pkgs; [
            gst_all_1.gstreamer
            gst_all_1.gst-plugins-base
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
              && drv != pnpmLatest
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

        vaDriverPackages = [ pkgs.mesa ] ++ lib.optionals pkgs.stdenv.hostPlatform.isx86_64 [
          pkgs.intel-media-driver
          pkgs.intel-vaapi-driver
        ];

        vaDriverPath = lib.makeSearchPath "lib/dri" vaDriverPackages;

        gstreamerPluginPath = lib.makeSearchPath "lib/gstreamer-1.0" [
          pkgs.gst_all_1.gstreamer.out
          pkgs.gst_all_1.gst-plugins-base
          pkgs.gst_all_1.gst-plugins-good
          pkgs.gst_all_1.gst-plugins-bad
          pkgs.gst_all_1.gst-plugins-ugly
          pkgs.pipewire
        ];

        dockerRootfs =
          if pkgs.stdenv.isLinux then
            pkgs.runCommand "aperture-docker-rootfs" { } ''
              mkdir -p $out
              cp -R ${./packaging/docker/rootfs}/. $out/
              chmod -R u+w $out
              mkdir -p $out/etc/aperture
              substitute ${./packaging/docker/aperture.toml} $out/etc/aperture/aperture.toml \
                --replace-fail '@DEPLOY_VERSION@' '${deployVersion}' \
                --replace-fail '@WESTON@' '${patchedWeston}' \
                --replace-fail '@GSTREAMER@' '${pkgs.gst_all_1.gstreamer}' \
                --replace-fail '@GSTREAMER_PLUGIN_PATH@' '${gstreamerPluginPath}' \
                --replace-fail '@CHROMIUM@' '${pkgs.chromium}'
              substitute ${./packaging/traefik/static.yaml.template} $out/etc/aperture/traefik.yaml \
                --replace-fail '@ENTRYPOINT_ADDRESS@' ':8080' \
                --replace-fail '@DYNAMIC_CONFIG_DIR@' '/run/aperture/traefik/dynamic'
            ''
          else
            null;

        dockerImage = if pkgs.stdenv.isLinux then pkgs.dockerTools.buildLayeredImage {
          name = "aperture";
          tag = deployVersion;
          maxLayers = 120;
          contents = [
            aperture
            pkgs.traefik
            pkgs.chromium
            pkgs.bashInteractive
            pkgs.coreutils
            pkgs.curl
            pkgs.findutils
            pkgs.gnugrep
            pkgs.gnused
            pkgs.sudo
            (lib.getOutput "out" pkgs.fontconfig)
            pkgs.dejavu_fonts
            pkgs.cacert
          ] ++ vaDriverPackages;
          extraCommands = ''
            cp -R --preserve=mode,timestamps --no-preserve=ownership ${s6OverlayRootfs}/. .
            chmod u+w .
            chmod -R u+w etc
            cp -R --preserve=mode,timestamps --no-preserve=ownership ${dockerRootfs}/. .
            chmod u+w .
            chmod -R u+w etc

            mkdir -p etc/aperture home/aperture run usr/local/bin var/lib/aperture tmp
            chmod 0644 etc/aperture/aperture.toml
            chmod 0755 \
              etc/cont-init.d/00-aperture \
              etc/services.d/aperture/run \
              etc/services.d/gc/run \
              etc/services.d/traefik/run

            cat > etc/passwd <<'EOF'
            root:x:0:0:root:/root:/bin/sh
            aperture:x:1000:1000:Aperture:/home/aperture:/bin/sh
            nobody:x:65534:65534:Nobody:/:/sbin/nologin
            EOF
            cat > etc/group <<'EOF'
            root:x:0:
            aperture:x:1000:
            nobody:x:65534:
            EOF
            cat > etc/nsswitch.conf <<'EOF'
            passwd: files
            group: files
            hosts: files dns
            EOF
            rm -f etc/sudoers
            rm -rf etc/sudoers.d
            mkdir -p etc/sudoers.d
            mkdir -p etc/pam.d
            cat > etc/sudoers <<'EOF'
            Defaults env_reset
            Defaults secure_path="/usr/local/bin:${lib.makeBinPath [ aperture pkgs.coreutils pkgs.sudo ]}"
            root ALL=(ALL:ALL) ALL
            @includedir /etc/sudoers.d
            EOF
            cat > etc/sudoers.d/aperture <<'EOF'
            aperture ALL=(root) NOPASSWD: /bin/aperture-mount-session *
            aperture ALL=(root) NOPASSWD: /bin/aperture-unmount-session *
            EOF
            cat > etc/pam.d/sudo <<'EOF'
            auth required ${pkgs.pam}/lib/security/pam_permit.so
            account required ${pkgs.pam}/lib/security/pam_permit.so
            session required ${pkgs.pam}/lib/security/pam_permit.so
            EOF
            chmod 0440 etc/sudoers etc/sudoers.d/aperture
            chmod 0644 etc/pam.d/sudo
            cp ${pkgs.sudo}/bin/sudo usr/local/bin/sudo
            rm -f bin/sudo
            ln -s ../usr/local/bin/sudo bin/sudo
            chmod 1777 tmp
          '';
          fakeRootCommands = ''
            chmod 4755 package/admin/s6-overlay-helpers-0.1.2.2/command/s6-overlay-suexec
            chmod 4755 usr/local/bin/sudo
          '';
          config = {
            Entrypoint = [ "/init" ];
            WorkingDir = "/var/lib/aperture";
            Env = [
              "HOME=/home/aperture"
              "XDG_RUNTIME_DIR=/run/aperture/user"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              "PATH=/command:/usr/local/bin:${lib.makeBinPath [ aperture pkgs.traefik pkgs.chromium pkgs.bashInteractive pkgs.coreutils pkgs.curl pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.sudo ]}"
              "S6_BEHAVIOUR_IF_STAGE2_FAILS=2"
              "S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0"
              "S6_KILL_GRACETIME=30000"
              "S6_SERVICES_GRACETIME=30000"
              "LIBGL_DRIVERS_PATH=${pkgs.mesa}/lib/dri"
              "LIBVA_DRIVERS_PATH=${vaDriverPath}"
              "__EGL_VENDOR_LIBRARY_FILENAMES=${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json"
            ];
            ExposedPorts = { "8080/tcp" = { }; };
            Volumes = { "/var/lib/aperture" = { }; };
            Labels = {
              "org.opencontainers.image.source" = "https://github.com/tarik02/aperture";
              "org.opencontainers.image.revision" = deployVersion;
              "org.opencontainers.image.version" = deployVersion;
            };
          };
        } else null;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            goLatest
            pkgs.gopls
            pkgs.nodejs_22
            pnpmLatest
            pkgs.pkg-config
            pkgs.sqlite
            pkgs.traefik
            pkgs.chromium
            pkgs.ffmpeg
            pkgs.gst_all_1.gstreamer
            pkgs.gst_all_1.gst-plugins-base
            pkgs.bubblewrap
            pkgs.libxkbcommon
            pkgs.pixman
            pkgs.wayland.dev
            patchedWeston
            agentBrowser
          ];
        };

        packages = {
          default = aperture;
          aperture = aperture;
        } // lib.optionalAttrs pkgs.stdenv.isLinux {
          aperture-docker = dockerImage;
        };

        checks.default = aperture;
      }) // {
      nixosModules.aperture = import ./packaging/nix/module.nix { inherit self; };
    };
}
