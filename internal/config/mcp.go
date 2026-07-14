package config

import (
	"errors"
	"fmt"

	"github.com/aperture/aperture/internal/agentbrowser"
)

func validateMCP(cfg Config) []error {
	if !cfg.MCPEnabled && cfg.AgentBrowserToolsDefault == "" && cfg.AgentBrowserIdleTimeout == 0 && cfg.ToolOutputMaxBytes == 0 && cfg.SignedFileURLTTL == 0 && cfg.SignedFileURLMaxTTL == 0 {
		return nil
	}

	var errs []error
	if _, err := agentbrowser.ParseProfiles(cfg.AgentBrowserToolsDefault); err != nil {
		errs = append(errs, fmt.Errorf("agent_browser_tools_default: %w", err))
	}
	if cfg.AgentBrowserIdleTimeout <= 0 {
		errs = append(errs, errors.New("agent_browser_idle_timeout must be positive"))
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
