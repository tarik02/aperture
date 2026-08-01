package main

import (
	"fmt"
	"os"

	"github.com/aperture/aperture/internal/browser"
)

func main() {
	if err := browser.RunExtensionNativeHost(); err != nil {
		fmt.Fprintf(os.Stderr, "aperture-extension-native-host: %v\n", err)
		os.Exit(1)
	}
}
