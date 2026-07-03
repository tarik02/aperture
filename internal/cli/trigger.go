package cli

import "github.com/spf13/cobra"

func newTriggerCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "trigger",
		Short: "trigger internal jobs",
	}
	cmd.AddCommand(placeholder("gc"))
	return cmd
}
