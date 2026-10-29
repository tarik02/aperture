package main

import (
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/browser"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == browser.MediaProbeArg {
		if err := browser.RunMediaEncoderProbe(os.Stdin, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "media encoder probe: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := browser.LaunchFromRuntimeEnv(); err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: %v\n", err)
		os.Exit(1)
	}
}
