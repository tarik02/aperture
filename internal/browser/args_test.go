package browser

import (
	"errors"
	"testing"
)

func TestValidateBrowserArgsRejectsDeniedArgs(t *testing.T) {
	t.Parallel()

	cases := []string{
		"--user-data-dir=/tmp/profile",
		"--remote-debugging-address=0.0.0.0",
		"--remote-debugging-port=9222",
		"--remote-allow-origins=https://example.test",
		"--disk-cache-dir=/tmp/cache",
		"--media-cache-dir=/tmp/cache",
		"--download-default-directory=/tmp/downloads",
	}

	for _, arg := range cases {
		arg := arg
		t.Run(arg, func(t *testing.T) {
			t.Parallel()
			err := ValidateBrowserArgs([]string{arg})
			if !errors.Is(err, ErrDeniedBrowserArg) {
				t.Fatalf("error = %v, want %v", err, ErrDeniedBrowserArg)
			}
		})
	}
}

func TestValidateBrowserArgsAllowsSafeArgs(t *testing.T) {
	t.Parallel()

	err := ValidateBrowserArgs([]string{"--disable-sync", "--window-size=800,600"})
	if err != nil {
		t.Fatalf("ValidateBrowserArgs() error = %v", err)
	}
}

func TestBuildLaunchArgsPreservesRequiredArgs(t *testing.T) {
	t.Parallel()

	args, err := BuildLaunchArgs("/merged", "/cache", 9222, []string{"--no-first-run"}, []string{"--disable-sync"})
	if err != nil {
		t.Fatalf("BuildLaunchArgs() error = %v", err)
	}

	if args[0] != "--user-data-dir=/merged" {
		t.Fatalf("first arg = %q", args[0])
	}
	if args[3] != "--remote-allow-origins=*" {
		t.Fatalf("remote allow origins arg = %q", args[3])
	}
	if args[len(args)-1] != "--disable-sync" {
		t.Fatalf("last arg = %q", args[len(args)-1])
	}
}

func TestBuildLaunchArgsRejectsDeniedExtraArgs(t *testing.T) {
	t.Parallel()

	_, err := BuildLaunchArgs("/merged", "/cache", 9222, nil, []string{"--remote-debugging-port=1"})
	if !errors.Is(err, ErrDeniedBrowserArg) {
		t.Fatalf("error = %v, want %v", err, ErrDeniedBrowserArg)
	}
}
