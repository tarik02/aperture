//go:build !linux

package supervisor

import (
	"fmt"

	"github.com/aperture/aperture/internal/config"
)

func newDirectBackend(config.Config) (browserBackend, error) {
	return nil, fmt.Errorf("direct browser supervisor requires linux")
}
