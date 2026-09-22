package config

import (
	"errors"
	"fmt"

	"github.com/aperture/aperture/internal/playwrightmcp"
)

func validateMCP(cfg Config) []error {
	if !cfg.MCPEnabled && cfg.PlaywrightToolsDefault == "" && cfg.ToolOutputMaxBytes == 0 && cfg.SignedFileURLTTL == 0 && cfg.SignedFileURLMaxTTL == 0 {
		return nil
	}

	var errs []error
	if _, err := playwrightmcp.ParseProfiles(cfg.PlaywrightToolsDefault); err != nil {
		errs = append(errs, fmt.Errorf("playwright_tools_default: %w", err))
	}
	if cfg.ToolOutputMaxBytes <= 0 {
		errs = append(errs, errors.New("tool_output_max_bytes must be positive"))
	}
	if cfg.SignedFileURLTTL <= 0 {
		errs = append(errs, errors.New("signed_file_url_ttl must be positive"))
	}
	if cfg.SignedFileURLMaxTTL <= 0 {
		errs = append(errs, errors.New("signed_file_url_max_ttl must be positive"))
	} else if cfg.SignedFileURLTTL > cfg.SignedFileURLMaxTTL {
		errs = append(errs, errors.New("signed_file_url_ttl must not exceed signed_file_url_max_ttl"))
	}
	return errs
}
