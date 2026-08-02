{
  description = "aperture chromium session supervisor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
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

        sourceVersion = self.shortRev or self.dirtyShortRev or "dev";

        deployVersion =
          if builtins.pathExists ./.aperture-deploy-version then
            builtins.readFile ./.aperture-deploy-version
          else
            sourceVersion;

        sourceRevision =
          if builtins.pathExists ./.aperture-source-revision then
            builtins.readFile ./.aperture-source-revision
          else if self ? rev then
            self.rev
          else if self ? dirtyRev then
            lib.removeSuffix "-dirty" self.dirtyRev
          else
            "unknown";

        isPackageSourceExcluded =
          path:
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
          filter = path: type: lib.cleanSourceFilter path type && !isPackageSourceExcluded path;
        };

        browserFonts = [
          pkgs.dejavu_fonts
          pkgs.noto-fonts
          pkgs.noto-fonts-cjk-sans
          pkgs.noto-fonts-color-emoji
        ];

        browserFontsConf = pkgs.makeFontsConf {
          fontDirectories = browserFonts;
        };

        runtimeGstreamer =
          (pkgs.gst_all_1.gstreamer.override {
            enableDocumentation = false;
            withIntrospection = false;
          }).overrideAttrs
            (oldAttrs: {
              postInstall = (oldAttrs.postInstall or "") + ''
                rm -f $out/libexec/gstreamer-1.0/gst-plugins-doc-cache-generator
              '';
            });

        runtimeGstPluginsBase =
          (pkgs.gst_all_1.gst-plugins-base.override {
            gstreamer = runtimeGstreamer;
            withIntrospection = false;
            enableX11 = false;
            enableWayland = true;
            enableAlsa = false;
            enableGl = false;
            enableCdparanoia = false;
            enableDocumentation = false;
          }).overrideAttrs
            (oldAttrs: {
              mesonFlags = (oldAttrs.mesonFlags or [ ]) ++ [
                "-Dauto_features=disabled"
                "-Dapp=enabled"
                "-Dvideoconvertscale=enabled"
                "-Dvideorate=enabled"
              ];
            });

        runtimeGstPluginsGood =
          (pkgs.gst_all_1.gst-plugins-good.override {
            gst-plugins-base = runtimeGstPluginsBase;
            enableJack = false;
            enableX11 = false;
            enableWayland = false;
            enableDocumentation = false;
          }).overrideAttrs
            (oldAttrs: {
              mesonFlags = (oldAttrs.mesonFlags or [ ]) ++ [
                "-Dauto_features=disabled"
                "-Dmatroska=enabled"
                "-Drtp=enabled"
                "-Dudp=enabled"
                "-Dvideocrop=enabled"
                "-Dvpx=enabled"
              ];
            });

        runtimeGstPluginsBad =
          (pkgs.gst_all_1.gst-plugins-bad.override {
            gst-plugins-base = runtimeGstPluginsBase;
            enableZbar = false;
            faacSupport = false;
            opencvSupport = false;
            lcevcdecSupport = false;
            ldacbtSupport = false;
            webrtcAudioProcessingSupport = false;
            ajaSupport = false;
            openh264Support = false;
            enableGplPlugins = false;
            bluezSupport = false;
            microdnsSupport = false;
            enableDocumentation = false;
            guiSupport = false;
          }).overrideAttrs
            (oldAttrs: {
              mesonFlags = (oldAttrs.mesonFlags or [ ]) ++ [
                "-Dauto_features=disabled"
                "-Dopenaptx=disabled"
                "-Dva=enabled"
                "-Dvideoparsers=enabled"
              ];
            });

        runtimePipewire =
          (pkgs.pipewire.override {
            gst_all_1 = pkgs.gst_all_1 // {
              gstreamer = runtimeGstreamer;
              gst-plugins-base = runtimeGstPluginsBase;
            };
            enableSystemd = false;
            vulkanSupport = false;
            bluezSupport = false;
            zeroconfSupport = false;
            raopSupport = false;
            rocSupport = false;
            x11Support = false;
            ffadoSupport = false;
          }).overrideAttrs
            (oldAttrs: {
              outputs = [
                "out"
                "jack"
                "dev"
              ];
              mesonFlags =
                builtins.filter (flag: !lib.hasPrefix "-Dinstalled_test_prefix=" flag) (oldAttrs.mesonFlags or [ ])
                ++ [
                  "-Dauto_features=disabled"
                  "-Dalsa=disabled"
                  "-Davb=disabled"
                  "-Dcompress-offload=disabled"
                  "-Ddocs=disabled"
                  "-Decho-cancel-webrtc=disabled"
                  "-Dexamples=disabled"
                  "-Dffmpeg=disabled"
                  "-Dgstreamer=enabled"
                  "-Dgstreamer-device-provider=disabled"
                  "-Dinstalled_tests=disabled"
                  "-Dlibcamera=disabled"
                  "-Dlibmysofa=disabled"
                  "-Dlibpulse=disabled"
                  "-Dlogind=disabled"
                  "-Dman=disabled"
                  "-Dopus=disabled"
                  "-Dpipewire-alsa=disabled"
                  "-Dpipewire-v4l2=disabled"
                  "-Dpw-cat-ffmpeg=disabled"
                  "-Dselinux=disabled"
                  "-Dsystemd-user-service=disabled"
                  "-Dtests=disabled"
                  "-Dudev=disabled"
                  "-Dv4l2=disabled"
                ];
              doInstallCheck = false;
            });

        runtimeWirePlumber =
          (pkgs.wireplumber.override {
            pipewire = runtimePipewire;
            enableDocs = false;
            enableGI = false;
          }).overrideAttrs
            (oldAttrs: {
              nativeBuildInputs = (oldAttrs.nativeBuildInputs or [ ]) ++ [ pkgs.python3 ];
              mesonFlags = (oldAttrs.mesonFlags or [ ]) ++ [
                "-Ddbus-tests=false"
                "-Dsystemd=disabled"
                "-Dsystemd-system-service=false"
                "-Dsystemd-user-service=false"
                "-Dtests=false"
                "-Dtools=false"
              ];
            });

        mkRuntimeMesa =
          mesaPackage:
          pkgs.runCommand "mesa-${mesaPackage.version}"
            {
              nativeBuildInputs = [ pkgs.patchelf ];
            }
            ''
              cp -a ${mesaPackage}/. $out/
              chmod -R u+w $out
              rm -f \
                $out/bin/mesa-overlay-control.py \
                $out/bin/mesa-screenshot-control.py

              if [[ ''${#out} -ne ${toString (builtins.stringLength (toString mesaPackage))} ]]; then
                echo "runtime and source Mesa paths must have equal lengths" >&2
                exit 1
              fi

              while IFS= read -r -d "" file; do
                rpath="$(patchelf --print-rpath "$file" 2>/dev/null || true)"
                if [[ "$rpath" == *'${mesaPackage}'* ]]; then
                  patchelf --set-rpath "''${rpath//'${mesaPackage}'/$out}" "$file"
                fi
              done < <(find $out -type f -print0)

              while IFS= read -r -d "" file; do
                sed -i "s|${mesaPackage}|$out|g" "$file"
              done < <(grep -lRZ -F '${mesaPackage}' $out)

              if grep -qR -F '${mesaPackage}' $out; then
                echo "runtime Mesa still references the unpruned package" >&2
                exit 1
              fi
            '';

        gpuMesa = mkRuntimeMesa (
          (pkgs.mesa.override {
            galliumDrivers = builtins.filter (
              driver:
              !builtins.elem driver [
                "llvmpipe"
                "softpipe"
              ]
            ) pkgs.mesa.galliumDrivers;
            vulkanDrivers = builtins.filter (driver: driver != "swrast") pkgs.mesa.vulkanDrivers;
            vulkanLayers = [ ];
            withValgrind = false;
          }).overrideAttrs
            (oldAttrs: {
              mesonFlags = (oldAttrs.mesonFlags or [ ]) ++ [
                "-Dteflon=false"
                "-Dgallium-extra-hud=false"
                "-Dintel-rt=disabled"
                "-Dtools="
                "-Dinstall-mesa-clc=false"
                "-Dinstall-precomp-compiler=false"
              ];
              postInstall = (oldAttrs.postInstall or "") + ''
                mkdir -p $cross_tools $spirv2dxil
              '';
            })
        );

        intelMesa = mkRuntimeMesa (
          (pkgs.mesa.override {
            galliumDrivers = [
              "crocus"
              "iris"
            ];
            vulkanDrivers = [ ];
            vulkanLayers = [ ];
            enablePatentEncumberedCodecs = false;
            withValgrind = false;
          }).overrideAttrs
            (oldAttrs: {
              outputs = [ "out" ];
              nativeBuildInputs = (oldAttrs.nativeBuildInputs or [ ]) ++ [ pkgs.mesa.cross_tools ];
              mesonFlags = (oldAttrs.mesonFlags or [ ]) ++ [
                "-Dteflon=false"
                "-Dgallium-extra-hud=false"
                "-Dgallium-rusticl=false"
                "-Dgallium-va=disabled"
                "-Dintel-rt=disabled"
                "-Dllvm=disabled"
                "-Dmesa-clc=system"
                "-Dprecomp-compiler=system"
                "-Dtools="
                "-Dinstall-mesa-clc=false"
                "-Dinstall-precomp-compiler=false"
              ];
              postInstall = "";
              postFixup = builtins.replaceStrings [ "$opencl/lib/libRusticlOpenCL.so" ] [ "" ] (
                oldAttrs.postFixup or ""
              );
            })
        );

        runtimeChromium =
          pkgs.runCommand "aperture-chromium-${pkgs.chromium.version}"
            {
              nativeBuildInputs = [ pkgs.makeWrapper ];
            }
            ''
              mkdir -p $out/bin $out/libexec
              cp -a ${pkgs.chromium.browser}/libexec/chromium $out/libexec/chromium
              chmod -R u+w $out/libexec/chromium
              rm -f \
                $out/libexec/chromium/locales/*.pak.info \
                $out/libexec/chromium/libVkLayer_khronos_validation.so

              makeWrapper $out/libexec/chromium/chromium $out/bin/chromium \
                --set CHROME_WRAPPER chromium \
                --set FONTCONFIG_FILE ${browserFontsConf} \
                --prefix LD_LIBRARY_PATH : ${
                  lib.makeLibraryPath [
                    pkgs.libva
                    runtimePipewire
                    pkgs.wayland
                    pkgs.gtk3
                    pkgs.krb5.lib
                  ]
                }

              if grep -qR -F '${pkgs.chromium.browser}' $out; then
                echo "runtime Chromium still references the unpruned package" >&2
                exit 1
              fi
            '';

        patchedWeston =
          (pkgs.weston.override {
            demoSupport = false;
            jpegSupport = false;
            lcmsSupport = false;
            luaSupport = false;
            pangoSupport = false;
            pipewireSupport = true;
            pipewire = runtimePipewire;
            rdpSupport = false;
            remotingSupport = false;
            vncSupport = false;
            vulkanSupport = false;
            webpSupport = false;
            xwaylandSupport = false;
          }).overrideAttrs
            (oldAttrs: {
              patches = (oldAttrs.patches or [ ]) ++ [
                (builtins.toFile "weston-pipewire-head-destroy.patch" ''
                  diff --git a/libweston/backend-pipewire/pipewire.c b/libweston/backend-pipewire/pipewire.c
                  --- a/libweston/backend-pipewire/pipewire.c
                  +++ b/libweston/backend-pipewire/pipewire.c
                  @@ -1249,6 +1249,7 @@ pipewire_output_set_gbm_format(struct weston_output *base, const char *gbm_forma

                   static const struct weston_pipewire_output_api api = {
                   ${"\t"}pipewire_head_create,
                  +${"\t"}pipewire_head_destroy,
                   ${"\t"}pipewire_output_set_size,
                   ${"\t"}pipewire_output_set_gbm_format,
                   };

                  diff --git a/include/libweston/backend-pipewire.h b/include/libweston/backend-pipewire.h
                  --- a/include/libweston/backend-pipewire.h
                  +++ b/include/libweston/backend-pipewire.h
                  @@ -54,6 +54,12 @@ struct weston_pipewire_output_api {
                   ${"\t"}void (*head_create)(struct weston_backend *backend,
                   ${"\t"}${"\t"}${"\t"}    const char *name,
                   ${"\t"}${"\t"}${"\t"}    const struct pipewire_config *config);
                  +
                  +${"\t"}/** Destroy a PipeWire head created by head_create.
                  +${"\t"} *
                  +${"\t"} * The head must not be attached to an output.
                  +${"\t"} */
                  +${"\t"}void (*head_destroy)(struct weston_head *head);

                   ${"\t"}/** Set the size and frame rate of a PipeWire output to the specified value.
                   ${"\t"} *
                '')
              ];
            });

        agentBrowserBinary =
          if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
            "agent-browser-linux-x64"
          else if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then
            "agent-browser-linux-arm64"
          else if pkgs.stdenv.hostPlatform.system == "x86_64-darwin" then
            "agent-browser-darwin-x64"
          else if pkgs.stdenv.hostPlatform.system == "aarch64-darwin" then
            "agent-browser-darwin-arm64"
          else
            throw "agent-browser is not packaged for ${pkgs.stdenv.hostPlatform.system}";

        agentBrowser = pkgs.stdenvNoCC.mkDerivation {
          pname = "agent-browser";
          version = "0.31.2";

          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/agent-browser/-/agent-browser-0.31.2.tgz";
            hash = "sha512-TkqqlFIIs9XFR7GCX92syuWdbWy3pcGkTsBKk/oncofVfICmaMJHnAeXk2MciE1SEUonzRqVNUCnYCqcO8rqWA==";
          };

          nativeBuildInputs = [
            pkgs.makeWrapper
          ]
          ++ lib.optionals pkgs.stdenv.isLinux [
            pkgs.patchelf
          ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/bin $out/libexec/agent-browser $out/share/agent-browser $out/share/licenses/agent-browser
            cp bin/${agentBrowserBinary} $out/libexec/agent-browser/agent-browser
            cp -R skill-data $out/share/agent-browser/skills
            cp LICENSE $out/share/licenses/agent-browser/LICENSE
            chmod +x $out/libexec/agent-browser/agent-browser

            ${lib.optionalString pkgs.stdenv.isLinux ''
              patchelf \
                --set-interpreter ${pkgs.stdenv.cc.bintools.dynamicLinker} \
                $out/libexec/agent-browser/agent-browser
            ''}

            makeWrapper $out/libexec/agent-browser/agent-browser $out/bin/agent-browser \
              --set AGENT_BROWSER_SKILLS_DIR $out/share/agent-browser/skills

            runHook postInstall
          '';
        };

        s6OverlayVersion = "3.2.3.1";
        s6OverlayArch =
          if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
            {
              archive = "x86_64";
              hash = "sha256-7XL9s6vxlkctEhsCa+1jtG80Q1B70s5n32vRh/fU3Ao=";
            }
          else if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then
            {
              archive = "aarch64";
              hash = "sha256-x5tcx+XkBfbhrhRmqBYKyE0puGYU4eAf8PsR3IMv7hs=";
            }
          else
            null;

        s6OverlayNoarch = pkgs.fetchurl {
          url = "https://github.com/just-containers/s6-overlay/releases/download/v${s6OverlayVersion}/s6-overlay-noarch.tar.xz";
          hash = "sha256-Q9mdJm/v4yzcFRCWOqreshHMhFC2CvJ4F7ZK9FDJNL4=";
        };

        s6OverlayRootfs =
          if pkgs.stdenv.isLinux then
            pkgs.runCommand "s6-overlay-rootfs-${s6OverlayVersion}"
              {
                nativeBuildInputs = [
                  pkgs.gnutar
                  pkgs.xz
                ];
              }
              ''
                mkdir -p $out
                tar -C $out --no-same-owner --no-same-permissions -Jxf ${s6OverlayNoarch}
                tar -C $out --no-same-owner --no-same-permissions -Jxf ${
                  pkgs.fetchurl {
                    url = "https://github.com/just-containers/s6-overlay/releases/download/v${s6OverlayVersion}/s6-overlay-${s6OverlayArch.archive}.tar.xz";
                    hash = s6OverlayArch.hash;
                  }
                }
              ''
          else
            null;

        aperture =
          (buildGoModule (finalAttrs: {
            pname = "aperture";
            version = deployVersion;
            inherit src;
            vendorHash = "sha256-aR7Juawx9M2IfdCclhtMDET4ZNP1sCeXfrOSP/8LlJ0=";

            subPackages = [
              "cmd/aperture"
              "cmd/aperture-extension-native-host"
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
              runtimeGstreamer
              runtimeGstPluginsBase
              libxkbcommon
              pixman
              wayland.dev
              patchedWeston
            ];

            env.CI = "true";
            env.CGO_ENABLED = "1";

            ldflags = [
              "-s"
              "-w"
              "-X github.com/aperture/aperture/internal/version.Version=${deployVersion}"
            ];

            preBuild = ''
              pnpm --filter @aperture/web build
              test -f web/dist/client/index.html
            '';

            # Vendor derivation only needs Go modules, not frontend dependencies.
            overrideModAttrs = oldAttrs: {
              nativeBuildInputs = builtins.filter (
                drv: drv != pkgs.pnpmConfigHook && drv != pnpmLatest && drv != pkgs.nodejs_22
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
              ${pkgs.wayland-scanner.bin}/bin/wayland-scanner private-code \
                ${pkgs.wayland-protocols}/share/wayland-protocols/unstable/text-input/text-input-unstable-v3.xml \
                $TMPDIR/aperture-wayland-protocols/text-input-unstable-v3-protocol.c
              ${pkgs.wayland-scanner.bin}/bin/wayland-scanner server-header \
                ${pkgs.wayland-protocols}/share/wayland-protocols/unstable/text-input/text-input-unstable-v3.xml \
                $TMPDIR/aperture-wayland-protocols/text-input-unstable-v3-server-protocol.h
              $CC -shared -fPIC \
                -I$TMPDIR/aperture-wayland-protocols \
                native/weston-aperture-shell/aperture-weston-shell.c \
                $TMPDIR/aperture-wayland-protocols/fractional-scale-v1-protocol.c \
                $TMPDIR/aperture-wayland-protocols/viewporter-protocol.c \
                $TMPDIR/aperture-wayland-protocols/cursor-shape-v1-protocol.c \
                $TMPDIR/aperture-wayland-protocols/tablet-v2-protocol.c \
                $TMPDIR/aperture-wayland-protocols/text-input-unstable-v3-protocol.c \
                -o $out/lib/weston/aperture-weston-shell.so \
                $(pkg-config --cflags --libs weston libweston-15 wayland-server pixman-1 xkbcommon)

              mkdir -p $out/share/aperture/extensions/tab-window-enforcer
              cp ${./extensions/tab-window-enforcer}/* $out/share/aperture/extensions/tab-window-enforcer/

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
                --prefix PATH : ${
                  lib.makeBinPath [
                    pkgs.bubblewrap
                    runtimeGstreamer
                    patchedWeston
                    runtimePipewire
                    runtimeWirePlumber
                  ]
                }

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
          })).overrideAttrs
            (oldAttrs: {
              checkPhase = ''
                runHook preCheck
                go test ./...
                runHook postCheck
              '';
            });

        gpuDriverPackages = [
          gpuMesa
        ]
        ++ lib.optionals pkgs.stdenv.hostPlatform.isx86_64 [
          pkgs.intel-media-driver
          pkgs.intel-vaapi-driver
        ];

        defaultDriverPackages = lib.optionals pkgs.stdenv.hostPlatform.isx86_64 [
          intelMesa
          pkgs.intel-media-driver
          pkgs.intel-vaapi-driver
        ];

        softwareGstreamerPluginPath = lib.makeSearchPath "lib/gstreamer-1.0" [
          runtimeGstreamer.out
          runtimeGstPluginsBase
          runtimeGstPluginsGood
          runtimePipewire
        ];

        gpuGstreamerPluginPath = lib.makeSearchPath "lib/gstreamer-1.0" [
          runtimeGstreamer.out
          runtimeGstPluginsBase
          runtimeGstPluginsGood
          runtimeGstPluginsBad
          runtimePipewire
        ];

        defaultGstreamerPluginPath =
          if pkgs.stdenv.hostPlatform.isx86_64 then
            gpuGstreamerPluginPath
          else
            softwareGstreamerPluginPath;

        mkDockerRootfs =
          {
            variant,
            gpuMode,
            compositorRenderer,
            gstreamerPluginPath,
          }:
          if pkgs.stdenv.isLinux then
            pkgs.runCommand "aperture-docker-rootfs-${variant}" { } ''
              mkdir -p $out
              cp -R ${./packaging/docker/rootfs}/. $out/
              chmod -R u+w $out
              mkdir -p $out/etc/aperture
              substitute ${./packaging/docker/aperture.toml} $out/etc/aperture/aperture.toml \
                --replace-fail '@DEPLOY_VERSION@' '${deployVersion}' \
                --replace-fail '@GPU_MODE@' '${gpuMode}' \
                --replace-fail '@WESTON@' '${patchedWeston}' \
                --replace-fail '@COMPOSITOR_RENDERER@' '${compositorRenderer}' \
                --replace-fail '@GSTREAMER@' '${runtimeGstreamer}' \
                --replace-fail '@GSTREAMER_PLUGIN_PATH@' '${gstreamerPluginPath}' \
                --replace-fail '@CHROMIUM@' '${runtimeChromium}'
              substitute ${./packaging/traefik/static.yaml.template} $out/etc/aperture/traefik.yaml \
                --replace-fail '@ENTRYPOINT_ADDRESS@' ':8080' \
                --replace-fail '@DYNAMIC_CONFIG_DIR@' '/run/aperture/traefik/dynamic'
            ''
          else
            null;

        mkDockerImage =
          {
            variant,
            tagSuffix,
            gpuMode,
            compositorRenderer,
            gstreamerPluginPath,
            hardware,
            driverPackages ? [ ],
          }:
          let
            dockerRootfs = mkDockerRootfs {
              inherit
                variant
                gpuMode
                compositorRenderer
                gstreamerPluginPath
                ;
            };
            vaDriverPath = lib.makeSearchPath "lib/dri" driverPackages;
          in
          if pkgs.stdenv.isLinux then
            pkgs.dockerTools.buildLayeredImage {
              name = "aperture";
              tag = "${deployVersion}${tagSuffix}";
              maxLayers = 120;
              contents = [
                aperture
                agentBrowser
                pkgs.traefik
                runtimeChromium
                pkgs.bashInteractive
                pkgs.coreutils
                pkgs.curl
                pkgs.findutils
                pkgs.gnugrep
                pkgs.gnused
                pkgs.sudo
                (lib.getOutput "out" pkgs.fontconfig)
                pkgs.cacert
              ]
              ++ browserFonts
              ++ driverPackages;
              extraCommands = ''
                cp -R --preserve=mode,timestamps --no-preserve=ownership ${s6OverlayRootfs}/. .
                chmod u+w .
                chmod -R u+w etc
                cp -R --preserve=mode,timestamps --no-preserve=ownership ${dockerRootfs}/. .
                chmod u+w .
                chmod -R u+w etc

                mkdir -p etc/aperture home/aperture run usr/local/bin usr/share/licenses/aperture var/lib/aperture tmp
                cp ${./LICENSE} usr/share/licenses/aperture/LICENSE
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
                Defaults secure_path="/usr/local/bin:${
                  lib.makeBinPath [
                    aperture
                    pkgs.coreutils
                    pkgs.sudo
                  ]
                }"
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
                  "PATH=/command:/usr/local/bin:${
                    lib.makeBinPath [
                      aperture
                      agentBrowser
                      pkgs.traefik
                      runtimeChromium
                      pkgs.bashInteractive
                      pkgs.coreutils
                      pkgs.curl
                      pkgs.findutils
                      pkgs.gnugrep
                      pkgs.gnused
                      pkgs.sudo
                    ]
                  }"
                  "S6_BEHAVIOUR_IF_STAGE2_FAILS=2"
                  "S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0"
                  "S6_KILL_GRACETIME=30000"
                  "S6_SERVICES_GRACETIME=30000"
                ]
                ++ lib.optionals hardware [
                  "LIBGL_DRIVERS_PATH=${builtins.head driverPackages}/lib/dri"
                  "LIBVA_DRIVERS_PATH=${vaDriverPath}"
                  "__EGL_VENDOR_LIBRARY_FILENAMES=${builtins.head driverPackages}/share/glvnd/egl_vendor.d/50_mesa.json"
                ];
                ExposedPorts = {
                  "8080/tcp" = { };
                }
                // lib.genAttrs (map (port: "${toString port}/udp") (lib.range 50000 50010)) (_: { });
                Healthcheck = {
                  Test = [
                    "CMD"
                    "curl"
                    "-fsS"
                    "http://127.0.0.1:8080/api/health"
                  ];
                  Interval = 10000000000;
                  Timeout = 3000000000;
                  Retries = 12;
                  StartPeriod = 15000000000;
                };
                Volumes = {
                  "/var/lib/aperture" = { };
                };
                Labels = {
                  "io.aperture.image.variant" = variant;
                  "org.opencontainers.image.title" = "Aperture";
                  "org.opencontainers.image.description" = "Chromium session supervisor";
                  "org.opencontainers.image.source" = "https://github.com/tarik02/aperture";
                  "org.opencontainers.image.url" = "https://aperture.tarik02.me";
                  "org.opencontainers.image.documentation" =
                    "https://github.com/tarik02/aperture/blob/master/docs/docker.md";
                  "org.opencontainers.image.licenses" = "MIT";
                  "org.opencontainers.image.revision" = sourceRevision;
                  "org.opencontainers.image.version" = deployVersion;
                };
              };
            }
          else
            null;

        defaultDockerImage = mkDockerImage {
          variant = "default";
          tagSuffix = "";
          gpuMode = "software";
          compositorRenderer = "pixman";
          gstreamerPluginPath = defaultGstreamerPluginPath;
          hardware = pkgs.stdenv.hostPlatform.isx86_64;
          driverPackages = defaultDriverPackages;
        };

        gpuDockerImage = mkDockerImage {
          variant = "gpu";
          tagSuffix = "-gpu";
          gpuMode = "hardware";
          compositorRenderer = "gl";
          gstreamerPluginPath = gpuGstreamerPluginPath;
          hardware = true;
          driverPackages = gpuDriverPackages;
        };

      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            goLatest
            pkgs.golangci-lint
            pkgs.gopls
            pkgs.goreleaser
            pkgs.nodejs_22
            pnpmLatest
            pkgs.pkg-config
            pkgs.sqlite
            pkgs.traefik
            pkgs.chromium
            pkgs.ffmpeg
            runtimeGstreamer
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
          agent-browser = agentBrowser;
          patched-weston = patchedWeston;
        }
        // lib.optionalAttrs pkgs.stdenv.isLinux {
          aperture-docker = defaultDockerImage;
          aperture-docker-gpu = gpuDockerImage;
        };

        checks.default = aperture;
      }
    )
    // {
      nixosModules.aperture = import ./packaging/nix/module.nix { inherit self; };
    };
}
