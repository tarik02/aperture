package cli

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/deploystate"
	"github.com/aperture/aperture/internal/traefik"
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
	cmd.PersistentFlags().String("browser-supervisor", "", "browser supervisor (systemd, direct)")
	cmd.PersistentFlags().String("log-level", "", "log level (debug, info, warn, error)")
	cmd.PersistentFlags().String("store-root", "", "persistent store root")
	cmd.PersistentFlags().String("runtime-root", "", "runtime state root")
	cmd.PersistentFlags().String("artifact-root", "", "artifact storage root")
	cmd.PersistentFlags().String("database-path", "", "sqlite database path")
	cmd.PersistentFlags().String("traefik-dynamic-config-dir", "", "traefik dynamic config directory")
	cmd.PersistentFlags().String("deploy-color", "", "deployment color (blue, green)")
	cmd.PersistentFlags().String("deploy-state-path", "", "deployment state file path")
	cmd.PersistentFlags().String("deploy-version", "", "deployment version")
	cmd.PersistentFlags().String("deploy-blue-url", "", "blue API URL")
	cmd.PersistentFlags().String("deploy-green-url", "", "green API URL")
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
	cmd.PersistentFlags().String("webrtc-media-producer-gst-executable", "", "media producer gst-launch executable path")
	cmd.PersistentFlags().String("webrtc-media-producer-plugin-path", "", "media producer plugin search path")
	cmd.PersistentFlags().String("webrtc-media-producer-target", "", "media producer PipeWire target")
	cmd.PersistentFlags().String("webrtc-media-producer-codec", "", "media producer codec (vp8, h264-va)")
	cmd.PersistentFlags().Int("webrtc-media-producer-fps", 0, "media producer frame rate")
	cmd.PersistentFlags().Int("webrtc-media-producer-bitrate-kbps", 0, "media producer bitrate in kbps")
	cmd.PersistentFlags().Int("webrtc-media-producer-keyframe-interval", 0, "media producer keyframe interval")

	if err := rootFlags.BindPFlags(cmd.PersistentFlags()); err != nil {
		panic(err)
	}

	cmd.AddCommand(
		newServeCmd(),
		newMigrateCmd(),
		newAdminCmd(),
		newDeploymentCmd(),
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

func newDeploymentCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:    "deployment",
		Short:  "deployment maintenance commands",
		Hidden: true,
	}

	state := &cobra.Command{
		Use:   "state",
		Short: "deployment state commands",
	}
	state.AddCommand(
		newDeploymentStateGetCmd(),
		newDeploymentStateMarkActiveCmd(),
	)

	edge := &cobra.Command{
		Use:   "edge",
		Short: "deployment edge route commands",
	}
	edge.AddCommand(newDeploymentEdgeWriteCmd())

	cmd.AddCommand(state, edge)
	return cmd
}

func newDeploymentStateGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get",
		Short: "print deployment state",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(rootFlags)
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			state, err := deploystate.New(cfg).Load()
			if err != nil {
				return fmt.Errorf("load deployment state: %w", err)
			}
			return writeDeploymentState(cmd, state)
		},
	}
}

func newDeploymentStateMarkActiveCmd() *cobra.Command {
	var version string

	cmd := &cobra.Command{
		Use:   "mark-active COLOR",
		Short: "mark a deployment color active",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(rootFlags)
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			activeVersion := version
			if strings.TrimSpace(activeVersion) == "" {
				activeVersion = cfg.DeployVersion
			}
			state, err := deploystate.New(cfg).MarkActive(args[0], activeVersion)
			if err != nil {
				return fmt.Errorf("mark active deployment state: %w", err)
			}
			return writeDeploymentState(cmd, state)
		},
	}
	cmd.Flags().StringVar(&version, "version", "", "active deployment version")
	return cmd
}

func newDeploymentEdgeWriteCmd() *cobra.Command {
	var color string
	var version string

	cmd := &cobra.Command{
		Use:   "write",
		Short: "write deployment edge dynamic config",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(rootFlags)
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			if strings.TrimSpace(color) != "" {
				edgeVersion := version
				if strings.TrimSpace(edgeVersion) == "" {
					edgeVersion = cfg.DeployVersion
				}
				state := deploystate.State{
					ActiveColor:   color,
					BlueURL:       cfg.DeployBlueURL,
					GreenURL:      cfg.DeployGreenURL,
					ActiveVersion: edgeVersion,
					UpdatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
				}
				if err := deploystate.Validate(state); err != nil {
					return fmt.Errorf("validate edge deployment state: %w", err)
				}
				if err := traefik.WriteEdgeConfigForState(cfg, state); err != nil {
					return fmt.Errorf("write deployment edge config: %w", err)
				}
				return nil
			}

			if err := traefik.WriteEdgeConfig(cfg, deploystate.New(cfg)); err != nil {
				return fmt.Errorf("write deployment edge config: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&color, "color", "", "edge deployment color")
	cmd.Flags().StringVar(&version, "version", "", "edge deployment version")
	return cmd
}

func writeDeploymentState(cmd *cobra.Command, state deploystate.State) error {
	encoder := json.NewEncoder(cmd.OutOrStdout())
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(state); err != nil {
		return fmt.Errorf("encode deployment state: %w", err)
	}
	return nil
}
