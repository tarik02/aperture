package cli

import (
	"github.com/aperture/aperture/internal/storage"
	"github.com/spf13/cobra"
)

func newStorageCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "storage",
		Short: "storage maintenance commands",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "migrate",
		Short: "move snapshots and session files from store_root to cold_root",
		Long: "Move snapshots and session files from store_root to cold_root after cold_root was changed. " +
			"Run it as the Aperture user while Aperture is stopped and no session is running. " +
			"Across filesystems every entry is copied, verified, and only then removed from store_root; " +
			"an interrupted run can be repeated.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer func() { _ = application.Close() }()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}
			return storage.Migrate(cmd.Context(), application.Config, application.Repository, cmd.OutOrStdout())
		},
	})
	return cmd
}
