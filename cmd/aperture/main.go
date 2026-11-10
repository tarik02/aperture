package main

import (
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/clientcli"
)

func main() {
	if err := clientcli.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "aperture:", err)
		os.Exit(1)
	}
}
