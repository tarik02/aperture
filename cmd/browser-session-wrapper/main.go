package main

import (
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/browser"
)

func main() {
	if err := browser.LaunchFromRuntimeEnv(); err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: %v\n", err)
		os.Exit(1)
	}
}
