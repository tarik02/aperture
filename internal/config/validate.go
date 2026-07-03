package config

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// Validate checks resolved configuration before service startup.
func Validate(cfg Config) error {
	var errs []error

	if strings.TrimSpace(cfg.ListenAddress) == "" {
		errs = append(errs, errors.New("listen_address is required"))
	} else if host, _, err := net.SplitHostPort(cfg.ListenAddress); err != nil {
		errs = append(errs, fmt.Errorf("listen_address: %w", err))
	} else if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		errs = append(errs, errors.New("listen_address must be loopback"))
	}

	switch strings.ToLower(strings.TrimSpace(cfg.LogLevel)) {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, errors.New("log_level must be debug, info, warn, or error"))
	}

	return errors.Join(errs...)
}
