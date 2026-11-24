{
  description = "aperture browser sessions";

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
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;
        nodeRuntime = pkgs.nodejs_26;
        pnpmLatest = pkgs.pnpm_11.override {
          nodejs-slim = nodeRuntime;
          version = "11.27.1";
          hash = "sha256-1Q+IQeZ+8LHYLnyQskBlbHygTV8aoz8GEIAHyB/XZ2Y=";
        };

        browserFonts = [
          pkgs.dejavu_fonts
          pkgs.liberation_ttf
          pkgs.noto-fonts
          pkgs.noto-fonts-cjk-sans
          pkgs.noto-fonts-color-emoji
          pkgs.roboto
        ];

        browserFontsConf = pkgs.writeText "aperture-fonts.conf" ''
          <?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
          <fontconfig>
            ${lib.concatMapStringsSep "\n" (font: "<dir>${font}</dir>") browserFonts}
            <cachedir prefix="xdg">fontconfig</cachedir>
            <config>
              <rescan>
                <int>0</int>
              </rescan>
            </config>

            <include>${lib.getOutput "out" pkgs.fontconfig}/etc/fonts/conf.d</include>

            <alias binding="strong">
              <family>system-ui</family>
              <prefer><family>Noto Sans</family></prefer>
            </alias>
            <alias binding="strong">
              <family>-apple-system</family>
              <prefer><family>Noto Sans</family></prefer>
            </alias>
            <alias binding="strong">
              <family>BlinkMacSystemFont</family>
              <prefer><family>Noto Sans</family></prefer>
            </alias>
            <alias binding="strong">
              <family>Segoe UI</family>
              <prefer><family>Noto Sans</family></prefer>
            </alias>
            <alias binding="strong">
              <family>Helvetica Neue</family>
              <prefer><family>Liberation Sans</family></prefer>
            </alias>
            <alias binding="strong">
              <family>Segoe UI Symbol</family>
              <prefer><family>Noto Sans Symbols2</family></prefer>
            </alias>
          </fontconfig>
        '';

        # libwayland-cursor, which Chromium loads cursors through, ignores XCURSOR_THEME and
        # only ever opens the theme named "default"; without one it draws its built-in bitmaps.
        browserCursorPath = pkgs.runCommand "aperture-cursor-theme" { } ''
          mkdir -p $out
          ln -s ${pkgs.adwaita-icon-theme}/share/icons/Adwaita $out/default
        '';

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
                --set XCURSOR_PATH ${browserCursorPath} \
                --set XCURSOR_THEME default \
                --set XCURSOR_SIZE 24 \
                --prefix XDG_DATA_DIRS : ${
                  # A dialog of the toolkit's own, such as one the session did not take
                  # over, ends the browser when it finds no settings schemas.
                  lib.concatMapStringsSep ":" (schemas: "${schemas}/share/gsettings-schemas/${schemas.name}") [
                    pkgs.gtk3
                    pkgs.gsettings-desktop-schemas
                  ]
                } \
                --prefix LD_LIBRARY_PATH : ${
                  lib.makeLibraryPath [
                    pkgs.libva
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

        # ffmpeg for the recording edits. The headless package has libx264 and libass; fontconfig is
        # pointed at the session's fonts for the captions.
        runtimeFfmpeg =
          pkgs.runCommand "aperture-ffmpeg-${pkgs.ffmpeg-headless.version}"
            {
              nativeBuildInputs = [ pkgs.makeWrapper ];
            }
            ''
              mkdir -p $out/bin
              makeWrapper ${lib.getBin pkgs.ffmpeg-headless}/bin/ffmpeg $out/bin/ffmpeg \
                --set FONTCONFIG_FILE ${browserFontsConf}
            '';

        # Fails the build when the packaged ffmpeg cannot do what the recording edits ask of it.
        ffmpegFeatureCheck =
          pkgs.runCommand "aperture-ffmpeg-features"
            {
              nativeBuildInputs = [ runtimeFfmpeg pkgs.fontconfig ];
            }
            ''
              export HOME=$TMPDIR
              encoders=$(ffmpeg -hide_banner -encoders)
              grep -qw libx264 <<<"$encoders" || { echo "ffmpeg lacks libx264" >&2; exit 1; }
              grep -qw aac <<<"$encoders" || { echo "ffmpeg lacks aac" >&2; exit 1; }
              filters=$(ffmpeg -hide_banner -filters)
              for filter in ass perspective select setpts fps aselect asetpts aresample trim pad setsar interleave; do
                grep -Eq "^ [A-Z.]+ +$filter +" <<<"$filters" || { echo "ffmpeg lacks the $filter filter" >&2; exit 1; }
              done
              export FONTCONFIG_FILE=${browserFontsConf}
              font=$(fc-match -f '%{file}' 'Noto Sans')
              case "$font" in
                ${pkgs.noto-fonts}/*) ;;
                *) echo "Noto Sans is not a bundled font: $font" >&2; exit 1 ;;
              esac
              # White caption pixels on a black frame prove the ASS filter actually renders text.
              printf '[Script Info]\nPlayResX: 320\nPlayResY: 240\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\nStyle: Default,Noto Sans,20,&H00FFFFFF,2\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,Hello\n' > c.ass
              ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=320x240:r=10:d=1 -vf ass=c.ass -c:v libx264 out.mp4
              [ -s out.mp4 ]
              ffmpeg -hide_banner -loglevel error -i out.mp4 -frames:v 1 -pix_fmt rgb24 -f rawvideo caption.rgb
              [ "$(wc -c < caption.rgb)" -eq 230400 ]
              pixels=$(od -An -tu1 -v caption.rgb | awk '{ for (i=1; i<=NF; i++) if ($i > 128) n++ } END { print n+0 }')
              [ "$pixels" -gt 100 ] || { echo "the caption did not produce visible text" >&2; exit 1; }
              touch $out
            '';

        gstPlugins = [
          pkgs.gst_all_1.gstreamer
          pkgs.gst_all_1.gst-plugins-base
          pkgs.gst_all_1.gst-plugins-good # matroskamux
          pkgs.gst_all_1.gst-plugins-bad # h264parse, nvcodec, va, openh264
          pkgs.gst_all_1.gst-plugins-ugly # x264enc
        ];

        version = (lib.importTOML ./Cargo.toml).workspace.package.version;
        # What the programs and the page are built of, so that nothing else builds them again.
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./Cargo.toml
            ./Cargo.lock
            ./buf.yaml
            ./crates
            ./proto
            ./apps
            ./packages
            # A member of the workspace, so the lockfile names it; its checks are not built.
            ./e2e/package.json
            # Another: the extension for a browser of someone's own, which no program has in it.
            ./extensions/aperture-companion/package.json
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./tsconfig.base.json
            ./vite.config.ts
          ];
        };

        # What the programs alone are built of: a change of the console or the control plane
        # builds none of them again.
        programsSrc = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./Cargo.toml
            ./Cargo.lock
            ./buf.yaml
            ./crates
            ./proto
          ];
        };

        workspacePnpmDeps = pkgs.fetchPnpmDeps {
          pname = "aperture-workspace";
          inherit version src;
          pnpm = pnpmLatest;
          fetcherVersion = 4;
          hash = "sha256-ZotD3JLYZaW6Elqq2cFXGsvdxwnC0nk1UX0G5ckUhCM=";
        };

        # The page that shows a session: one HTML file with everything it needs in it, which the
        # gateway takes into the programs.
        workbench = pkgs.stdenvNoCC.mkDerivation {
          pname = "aperture-workbench";
          inherit version src;
          pnpmDeps = workspacePnpmDeps;
          nativeBuildInputs = [
            nodeRuntime
            pnpmLatest
            pkgs.pnpmConfigHook
          ];
          env.CI = "true";
          buildPhase = ''
            runHook preBuild
            # pnpm 11.27.1 shims use `command -p`, which finds nothing in the sandbox.
            find . -path '*/node_modules/.bin/*' -type f -exec sed -i 's/command -p //g' {} +
            pnpm --filter @aperture-browser/workbench build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 apps/workbench/dist/index.html $out/index.html
            runHook postInstall
          '';
        };

        # The console as a directory of static files, for whatever serves it.
        console = pkgs.stdenvNoCC.mkDerivation {
          pname = "aperture-console";
          inherit version src;
          pnpmDeps = workspacePnpmDeps;
          nativeBuildInputs = [
            nodeRuntime
            pnpmLatest
            pkgs.pnpmConfigHook
          ];
          env.CI = "true";
          buildPhase = ''
            runHook preBuild
            find . -path '*/node_modules/.bin/*' -type f -exec sed -i 's/command -p //g' {} +
            pnpm --filter @aperture-browser/console build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            cp -r apps/console/dist $out
            runHook postInstall
          '';
        };

        # The control plane: one file of this workspace's own code, beside what it takes
        # from the registry, which is left as pnpm lays it out.
        control = pkgs.stdenvNoCC.mkDerivation {
          pname = "aperture-control";
          inherit version src;
          pnpmDeps = workspacePnpmDeps;
          nativeBuildInputs = [
            nodeRuntime
            pnpmLatest
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
          ];
          env.CI = "true";
          buildPhase = ''
            runHook preBuild
            find . -path '*/node_modules/.bin/*' -type f -exec sed -i 's/command -p //g' {} +
            pnpm --filter @aperture-browser/control build
            # What only builds and checks it is not what runs it.
            pnpm install --offline --frozen-lockfile --prod --filter @aperture-browser/control
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            lib=$out/lib/aperture-control
            mkdir -p $lib/apps/control
            cp -r node_modules $lib/node_modules
            cp -r apps/control/node_modules apps/control/dist apps/control/package.json $lib/apps/control/
            makeWrapper ${lib.getExe nodeRuntime} $out/bin/aperture-control \
              --add-flags --enable-source-maps \
              --add-flags $lib/apps/control/dist/main.mjs \
              --set-default APERTURE_CONTROL_CONSOLE_DIR ${console}
            runHook postInstall
          '';
          # The links pnpm makes to packages of the workspace that were left out lead nowhere.
          dontCheckForBrokenSymlinks = true;
          meta.mainProgram = "aperture-control";
        };

        # What moves a v1 installation into v2, packed as the control plane is: it writes
        # with the control plane's own code, and is told what the control plane is told.
        migrate = pkgs.stdenvNoCC.mkDerivation {
          pname = "aperture-migrate";
          inherit version src;
          pnpmDeps = workspacePnpmDeps;
          nativeBuildInputs = [
            nodeRuntime
            pnpmLatest
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
          ];
          env.CI = "true";
          buildPhase = ''
            runHook preBuild
            find . -path '*/node_modules/.bin/*' -type f -exec sed -i 's/command -p //g' {} +
            pnpm --filter @aperture-browser/migrate build
            # What only builds and checks it is not what runs it.
            pnpm install --offline --frozen-lockfile --prod --filter @aperture-browser/migrate
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            lib=$out/lib/aperture-migrate
            mkdir -p $lib/apps/migrate
            cp -r node_modules $lib/node_modules
            cp -r apps/migrate/node_modules apps/migrate/dist apps/migrate/package.json $lib/apps/migrate/
            # `cp` copies what overlayfs keeps in a session's profile, which is coreutils' to do.
            makeWrapper ${lib.getExe nodeRuntime} $out/bin/aperture-migrate \
              --prefix PATH : ${lib.makeBinPath [ pkgs.coreutils ]} \
              --add-flags --enable-source-maps \
              --add-flags $lib/apps/migrate/dist/main.mjs
            runHook postInstall
          '';
          # The links pnpm makes to packages of the workspace that were left out lead nowhere.
          dontCheckForBrokenSymlinks = true;
          meta.mainProgram = "aperture-migrate";
        };

        sessionLibraries = [
          pkgs.libxkbcommon
          pkgs.pixman
          pkgs.openssl
          pkgs.gst_all_1.gstreamer
          pkgs.gst_all_1.gst-plugins-base
          pkgs.libglvnd
          pkgs.libgbm
        ];

        # The programs as cargo builds them, which find nothing of what they run by themselves.
        apertureUnwrapped = pkgs.rustPlatform.buildRustPackage {
          pname = "aperture-unwrapped";
          inherit version;
          src = programsSrc;
          cargoLock = {
            lockFile = ./Cargo.lock;
            allowBuiltinFetchGit = true;
          };
          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.buf
          ];
          buildInputs = sessionLibraries;
          env.APERTURE_WORKBENCH = "${workbench}/index.html";
          preBuild = ''
            # buf keeps a cache in the home directory.
            export HOME=$TMPDIR
            # browse-script takes a file of browse-capture's by its place next to it in their
            # repository, which is not its place among vendored crates.
            vendored=$NIX_BUILD_TOP/cargo-vendor-dir
            capture=$(basename "$vendored"/browse-capture-*)
            ln -s "$capture" "$vendored/browse-capture"
          '';
          doCheck = false;
        };

        # The programs with what they run: the browser and its sandbox, ffmpeg, pasta, the
        # encoders. Each is still named by its option or its variable where another is wanted.
        aperture =
          pkgs.runCommand "aperture-${version}"
            {
              nativeBuildInputs = [ pkgs.makeWrapper ];
              meta.mainProgram = "aperture-runner";
            }
            ''
              mkdir -p $out/bin
              for program in aperture-runner aperture-executor; do
                makeWrapper ${apertureUnwrapped}/bin/$program $out/bin/$program \
                  --set-default APERTURE_BWRAP ${lib.getExe pkgs.bubblewrap} \
                  --set-default APERTURE_PASTA ${lib.getExe' pkgs.passt "pasta"} \
                  --set-default APERTURE_TAR ${lib.getExe pkgs.gnutar} \
                  --set-default APERTURE_ZSTD ${lib.getExe pkgs.zstd} \
                  --set-default APERTURE_CHROMIUM ${lib.getExe' runtimeChromium "chromium"} \
                  --set-default APERTURE_FFMPEG ${lib.getExe' runtimeFfmpeg "ffmpeg"} \
                  --set-default APERTURE_CURSOR_THEME ${browserCursorPath}/default \
                  --set-default FONTCONFIG_FILE ${browserFontsConf} \
                  --set-default APERTURE_GST_PLUGIN_PATH ${lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins} \
                  --prefix LD_LIBRARY_PATH : ${
                    # libEGL is found when the compositor starts; vendor drivers come from the system.
                    lib.makeLibraryPath [
                      pkgs.libglvnd
                      pkgs.libgbm
                    ]
                  }
              done
              ln -s ${apertureUnwrapped}/bin/aperture-tunnel $out/bin/aperture-tunnel
            '';

        # One session in a container: `aperture-runner serve`, with its directory at /data.
        # Its browser is sandboxed inside the container, with a /proc of its own, which a
        # container runtime does not let it mount over the one it masks: under podman it
        # runs with `--security-opt unmask=ALL`. A browser with a network of its own takes
        # `--device /dev/net/tun` as well.
        container = pkgs.dockerTools.streamLayeredImage {
          name = "aperture-session";
          tag = version;
          contents = [
            aperture
            pkgs.dockerTools.fakeNss
          ];
          extraCommands = ''
            mkdir -p data tmp run
            chmod 1777 tmp
          '';
          config = {
            Entrypoint = [
              (lib.getExe aperture)
              "serve"
            ];
            Env = [
              "APERTURE_DATA=/data"
              "APERTURE_LISTEN=0.0.0.0:7900"
              "APERTURE_RUNTIME_DIR=/run/aperture"
            ];
            ExposedPorts."7900/tcp" = { };
            Volumes."/data" = { };
            Labels = imageLabels;
          };
        };

        # The secrets the parts of a deployment share, made in the directory it is given.
        # Made once: what is there stays, since what was sealed and signed with it is
        # still read.
        keys = pkgs.writeShellApplication {
          name = "aperture-keys";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.openssl
          ];
          text = ''
            umask 077
            cd "''${1:?usage: aperture-keys DIRECTORY}"

            secret() { openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_'; }
            made() {
              local file=$1
              shift
              if [ ! -s "$file" ]; then
                "$@" > "$file.new"
                mv "$file.new" "$file"
              fi
            }

            made master.key secret
            made bootstrap-token secret
            made registration-token secret
            made proxy-token secret
            made ticket.pem openssl genpkey -algorithm ed25519
            openssl pkey -in ticket.pem -pubout -out ticket.pub.pem
          '';
        };

        imageLabels = {
          # A registry shows an image under the repository its source label names.
          "org.opencontainers.image.source" = "https://github.com/tarik02/aperture";
          "org.opencontainers.image.version" = version;
          "org.opencontainers.image.licenses" = "MIT";
        };

        # A node in a container: the executor, with its sessions below /data. Each
        # session's browser is sandboxed as in the session's image, and asks the same of
        # whatever runs the container.
        nodeImage = pkgs.dockerTools.streamLayeredImage {
          name = "aperture-node";
          tag = version;
          contents = [
            aperture
            pkgs.dockerTools.fakeNss
            # The executor trusts whom the system does when it speaks to a control plane.
            pkgs.dockerTools.caCertificates
          ];
          extraCommands = ''
            mkdir -p data tmp run
            chmod 1777 tmp
          '';
          config = {
            Entrypoint = [ (lib.getExe' aperture "aperture-executor") ];
            Env = [
              "HOME=/data"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
              "APERTURE_DATA_DIR=/data"
              "APERTURE_LISTEN=0.0.0.0:7900"
              "APERTURE_RUNTIME_DIR=/run/aperture"
            ];
            ExposedPorts."7900/tcp" = { };
            Volumes."/data" = { };
            Labels = imageLabels;
          };
        };

        # The control plane in a container, with the console it serves. `aperture-keys` is
        # in it as well, for whoever has the deployment's secrets made beside it.
        controlImage = pkgs.dockerTools.streamLayeredImage {
          name = "aperture-control";
          tag = version;
          contents = [
            control
            keys
            # Its health is asked with the runtime it has: the image has no shell.
            nodeRuntime
            pkgs.dockerTools.fakeNss
            pkgs.dockerTools.caCertificates
          ];
          extraCommands = ''
            mkdir -p tmp
            chmod 1777 tmp
          '';
          config = {
            Entrypoint = [ (lib.getExe control) ];
            Env = [
              "APERTURE_CONTROL_LISTEN_HOST=0.0.0.0"
              "APERTURE_CONTROL_LISTEN_PORT=7800"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
            ];
            ExposedPorts."7800/tcp" = { };
            Labels = imageLabels;
          };
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
            pkgs.buf
            pkgs.postgresql
            pkgs.traefik
            pkgs.dex-oidc
            pkgs.pkg-config
            nodeRuntime
            pnpmLatest
          ];
          buildInputs = sessionLibraries;
          # libEGL is found when the compositor starts; vendor drivers come from the system.
          LD_LIBRARY_PATH = lib.makeLibraryPath [
            pkgs.libglvnd
            pkgs.libgbm
          ];
          APERTURE_BWRAP = lib.getExe pkgs.bubblewrap;
          APERTURE_PASTA = lib.getExe' pkgs.passt "pasta";
          APERTURE_TAR = lib.getExe pkgs.gnutar;
          APERTURE_ZSTD = lib.getExe pkgs.zstd;
          APERTURE_CHROMIUM = lib.getExe' runtimeChromium "chromium";
          APERTURE_FFMPEG = lib.getExe' runtimeFfmpeg "ffmpeg";
          APERTURE_CURSOR_THEME = "${browserCursorPath}/default";
          APERTURE_GST_PLUGIN_PATH = lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins;
        };

        packages = {
          default = aperture;
          inherit aperture container;
          aperture-unwrapped = apertureUnwrapped;
          aperture-workbench = workbench;
          aperture-console = console;
          aperture-control = control;
          aperture-keys = keys;
          node-image = nodeImage;
          control-image = controlImage;
          aperture-migrate = migrate;
          aperture-chromium = runtimeChromium;
          aperture-ffmpeg = runtimeFfmpeg;
        };

        checks = {
          aperture-ffmpeg-features = ffmpegFeatureCheck;
          # One machine with everything on it, set up by the modules alone.
          deployment = pkgs.testers.runNixOSTest (import ./nix/tests/deployment.nix { inherit self; });
        };
      }
    )
    // {
      nixosModules = import ./nix/modules { inherit self; };
    };
}
