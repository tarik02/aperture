package cli

import (
	"github.com/aperture/aperture/internal/version"
	"github.com/spf13/cobra"
)

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "print build version information",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			cmd.Println(version.Details())
		},
	}
}
