package jobtoken

import "errors"

var (
	ErrMissing = errors.New("job token missing")
	ErrInvalid = errors.New("job token invalid")
)
