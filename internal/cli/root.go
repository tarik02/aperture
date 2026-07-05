package cli

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var rootFlags = viper.New()

// Execute runs the aperture CLI.
func Execute() error {
	return newRootCmd().Execute()
}

func newRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "aperture",
		Short: "chromium session supervisor",
	}

	cmd.PersistentFlags().String("config", "", "config file path")
	cmd.PersistentFlags().String("listen-address", "", "loopback listen address")
	cmd.PersistentFlags().String("log-level", "", "log level (debug, info, warn, error)")
	cmd.PersistentFlags().String("store-root", "", "persistent store root")
	cmd.PersistentFlags().String("runtime-root", "", "runtime state root")
	cmd.PersistentFlags().String("artifact-root", "", "artifact storage root")
	cmd.PersistentFlags().String("database-path", "", "sqlite database path")
	cmd.PersistentFlags().String("traefik-dynamic-config-path", "", "traefik dynamic config path")
	cmd.PersistentFlags().String("systemd-browser-unit-name", "", "systemd browser unit template name")
	cmd.PersistentFlags().Int("session-retention-days", 0, "session retention in days")
	cmd.PersistentFlags().Int("snapshot-retention-days", 0, "snapshot retention in days")
	cmd.PersistentFlags().String("external-base-url", "", "external base URL for generated links")
	cmd.PersistentFlags().String("cdp-route-base-path", "", "cdp route base path")
	cmd.PersistentFlags().String("webrtc-media-mode", "", "viewport media mode (auto, cdp)")
	cmd.PersistentFlags().Bool("webrtc-compositor-enabled", false, "enable nested compositor browser sessions")
	cmd.PersistentFlags().String("webrtc-compositor-executable", "", "nested compositor executable path")
	cmd.PersistentFlags().String("webrtc-compositor-backend", "", "nested compositor backend")
	cmd.PersistentFlags().String("webrtc-compositor-renderer", "", "nested compositor renderer")
	cmd.PersistentFlags().String("webrtc-compositor-shell", "", "nested compositor shell")
	cmd.PersistentFlags().Int("webrtc-compositor-width", 0, "nested compositor output width")
	cmd.PersistentFlags().Int("webrtc-compositor-height", 0, "nested compositor output height")
	cmd.PersistentFlags().Bool("webrtc-media-producer-enabled", false, "enable nested compositor media producer")
	cmd.PersistentFlags().String("webrtc-media-producer-executable", "", "media producer executable path")
	cmd.PersistentFlags().String("webrtc-media-producer-gst-executable", "", "media producer gst-launch executable path")
	cmd.PersistentFlags().String("webrtc-media-producer-plugin-path", "", "media producer plugin search path")
	cmd.PersistentFlags().String("webrtc-media-producer-target", "", "media producer PipeWire target")

	if err := rootFlags.BindPFlags(cmd.PersistentFlags()); err != nil {
		panic(err)
	}

	cmd.AddCommand(
		newServeCmd(),
		newMigrateCmd(),
		newAdminCmd(),
		newTriggerCmd(),
	)

	return cmd
}

func placeholder(name string) *cobra.Command {
	return &cobra.Command{
		Use:    name,
		Short:  "not implemented",
		Hidden: false,
		RunE: func(cmd *cobra.Command, args []string) error {
			return fmt.Errorf("%s: not implemented", cmd.CommandPath())
		},
	}
}
