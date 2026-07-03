package cli

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/jobtoken"
	"github.com/spf13/cobra"
)

func newTriggerCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "trigger",
		Short: "trigger internal jobs",
	}
	cmd.AddCommand(newTriggerGCCmd())
	return cmd
}

func newTriggerGCCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "gc",
		Short: "trigger garbage collection in the running aperture service",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(rootFlags)
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			token, err := jobtoken.Load(cfg)
			if err != nil {
				return fmt.Errorf("load job token: %w", err)
			}

			url := strings.TrimRight(cfg.ListenAddress, "/")
			if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
				url = "http://" + url
			}
			url += "/internal/jobs/gc"

			req, err := http.NewRequestWithContext(cmd.Context(), http.MethodPost, url, nil)
			if err != nil {
				return fmt.Errorf("build gc request: %w", err)
			}
			req.Header.Set("X-Aperture-Job-Token", token)

			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return fmt.Errorf("trigger gc: %w", err)
			}
			defer resp.Body.Close()

			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("trigger gc: status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
			}

			fmt.Fprintln(cmd.OutOrStdout(), string(bytes.TrimSpace(body)))
			return nil
		},
	}
}
