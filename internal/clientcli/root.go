// Package clientcli is the aperture-cli command: the client of a running
// Aperture instance, for machines that do not run Aperture themselves.
package clientcli

import (
	"github.com/aperture/aperture/internal/version"
	"github.com/spf13/cobra"
)

// Execute runs the aperture-cli command.
func Execute() error {
	return newRootCmd().Execute()
}

func newRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:           "aperture-cli",
		Short:         "client for a running Aperture instance",
		Version:       version.Short(),
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	cmd.SetVersionTemplate("{{.Name}} {{.Version}}\n")
	cmd.AddCommand(newTunnelCmd())

	return cmd
}
