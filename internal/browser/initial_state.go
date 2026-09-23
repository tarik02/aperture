package browser

import (
	"bytes"
	"encoding/json"
)

const MaxSessionInitializationBytes = 64 * 1024 * 1024

// SessionInitialization is the public browser-state capsule transport.
// Its inner payload is parsed by the restore worker.
type SessionInitialization struct {
	Targets      json.RawMessage `json:"initialTargets,omitempty"`
	StorageState json.RawMessage `json:"storageState,omitempty"`
}

func (input SessionInitialization) Empty() bool {
	targets := bytes.TrimSpace(input.Targets)
	storage := bytes.TrimSpace(input.StorageState)
	return (len(targets) == 0 || bytes.Equal(targets, []byte("[]")) || bytes.Equal(targets, []byte("null"))) &&
		(len(storage) == 0 || bytes.Equal(storage, []byte("null")))
}
