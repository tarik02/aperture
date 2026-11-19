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
              for filter in ass perspective select setpts fps aselect asetpts aresample; do
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
            pkgs.pkg-config
          ];
          buildInputs = [
            pkgs.libxkbcommon
            pkgs.pixman
            pkgs.openssl
            pkgs.gst_all_1.gstreamer
            pkgs.gst_all_1.gst-plugins-base
            pkgs.libglvnd
            pkgs.libgbm
          ];
          # libEGL is found when the compositor starts; vendor drivers come from the system.
          LD_LIBRARY_PATH = lib.makeLibraryPath [
            pkgs.libglvnd
            pkgs.libgbm
          ];
          APERTURE_BWRAP = lib.getExe pkgs.bubblewrap;
          APERTURE_CHROMIUM = lib.getExe' runtimeChromium "chromium";
          APERTURE_FFMPEG = lib.getExe' runtimeFfmpeg "ffmpeg";
          APERTURE_CURSOR_THEME = "${browserCursorPath}/default";
          APERTURE_GST_PLUGIN_PATH = lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gstPlugins;
        };

        packages = {
          aperture-chromium = runtimeChromium;
          aperture-ffmpeg = runtimeFfmpeg;
        };

        checks.aperture-ffmpeg-features = ffmpegFeatureCheck;
      }
    );
}
