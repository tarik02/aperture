package traefik

import "errors"

var (
	// ErrRender indicates dynamic configuration could not be rendered.
	ErrRender = errors.New("traefik config render failed")
	// ErrWrite indicates dynamic configuration could not be written.
	ErrWrite = errors.New("traefik config write failed")
)
