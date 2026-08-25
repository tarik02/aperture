package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/aperture/aperture/internal/devrunner"
)

func main() {
	if err := devrunner.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "aperture-dev: %v\n", err)

		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				os.Exit(128 + int(status.Signal()))
			}
			os.Exit(exitError.ExitCode())
		}
		os.Exit(2)
	}
}
