package browser

import (
	"errors"
	"fmt"
	"strings"
)

var ErrDeniedBrowserArg = errors.New("browser argument conflicts with supervisor-owned behavior")

var deniedBrowserArgs = map[string]struct{}{
	"--user-data-dir":                 {},
	"--remote-debugging-address":      {},
	"--remote-debugging-port":         {},
	"--disk-cache-dir":                {},
	"--media-cache-dir":               {},
	"--download-default-directory":    {},
	"--disable-download-notification": {},
	"--disable-crashpad":              {},
	"--disable-crashpad-for-testing":  {},
	"--disable-crash-reporter":        {},
}

var deniedBrowserArgPrefixes = []string{
	"--user-data-dir=",
	"--remote-debugging-address=",
	"--remote-debugging-port=",
	"--disk-cache-dir=",
	"--media-cache-dir=",
	"--download-default-directory=",
	"--disable-crashpad=",
	"--disable-crashpad-for-testing=",
	"--disable-crash-reporter=",
}

// ValidateBrowserArgs rejects args that conflict with supervisor-owned Chromium behavior.
func ValidateBrowserArgs(args []string) error {
	for _, arg := range args {
		trimmed := strings.TrimSpace(arg)
		if trimmed == "" {
			continue
		}
		if _, denied := deniedBrowserArgs[trimmed]; denied {
			return fmt.Errorf("%w: %q", ErrDeniedBrowserArg, trimmed)
		}
		for _, prefix := range deniedBrowserArgPrefixes {
			if strings.HasPrefix(trimmed, prefix) {
				return fmt.Errorf("%w: %q", ErrDeniedBrowserArg, trimmed)
			}
		}
	}
	return nil
}

// RequiredArgs returns Chromium args owned by the supervisor for a session.
func RequiredArgs(mergedUserDataDir string, cacheDir string, cdpPort int) []string {
	return []string{
		"--user-data-dir=" + mergedUserDataDir,
		"--remote-debugging-address=127.0.0.1",
		fmt.Sprintf("--remote-debugging-port=%d", cdpPort),
		"--disk-cache-dir=" + cacheDir,
		"--media-cache-dir=" + cacheDir,
		"--no-first-run",
		"--no-default-browser-check",
	}
}

// BuildLaunchArgs combines required, channel default, and validated extra args.
func BuildLaunchArgs(mergedUserDataDir string, cacheDir string, cdpPort int, defaultArgs, extraArgs []string) ([]string, error) {
	if err := ValidateBrowserArgs(defaultArgs); err != nil {
		return nil, err
	}
	if err := ValidateBrowserArgs(extraArgs); err != nil {
		return nil, err
	}

	args := append([]string(nil), RequiredArgs(mergedUserDataDir, cacheDir, cdpPort)...)
	args = append(args, defaultArgs...)
	args = append(args, extraArgs...)
	return args, nil
}
