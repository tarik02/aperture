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
