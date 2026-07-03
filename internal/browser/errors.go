package browser

import "errors"

var (
	ErrUnknownChannel = errors.New("unknown browser channel")
	ErrInvalidChannel = errors.New("invalid browser channel name")
)
