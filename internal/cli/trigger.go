package cli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/deploystate"
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

			state, err := deploystate.New(cfg).Load()
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return fmt.Errorf("load deployment state: %s is missing; active api url is unknown", cfg.DeployStatePath)
				}
				return fmt.Errorf("load deployment state: %w", err)
			}
			activeURL, err := deploystate.ActiveURL(state)
			if err != nil {
				return fmt.Errorf("resolve active api url: %w", err)
			}
			url := strings.TrimRight(activeURL, "/") + "/internal/jobs/gc"

			token, err := jobtoken.Load(cfg)
			if err != nil {
				return fmt.Errorf("load job token: %w", err)
			}

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
