package main

import (
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/sudo"
)

func main() {
	if err := sudo.RunUnmountCLI(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "aperture-unmount-session: %v\n", err)
		os.Exit(1)
	}
}
