package cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/aperture/aperture/internal/app"
	"github.com/aperture/aperture/internal/config"
	"github.com/spf13/cobra"
)

func newServeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "start the aperture http api",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(rootFlags)
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			application, err := app.New(cfg)
			if err != nil {
				return fmt.Errorf("init app: %w", err)
			}
			defer application.Close()

			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer stop()

			return application.Serve(ctx)
		},
	}
}
