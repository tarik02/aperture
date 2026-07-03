package cli

import (
	"fmt"

	"github.com/aperture/aperture/internal/app"
	"github.com/aperture/aperture/internal/config"
	"github.com/spf13/cobra"
)

func newMigrateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "migrate",
		Short: "run database migrations",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(rootFlags)
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			application, err := app.New(cmd.Context(), cfg)
			if err != nil {
				return fmt.Errorf("init app: %w", err)
			}
			defer application.Close()

			return application.Migrate(cmd.Context())
		},
	}
}
