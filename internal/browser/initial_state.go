package browser

import (
	"bytes"
	"encoding/json"
	"slices"
)

const MaxSessionInitializationBytes = 64 * 1024 * 1024

// SessionInitialization is the public browser-state capsule transport.
// Its inner payload is parsed by the restore worker.
type SessionInitialization struct {
	Targets      json.RawMessage `json:"initialTargets,omitempty"`
	StorageState json.RawMessage `json:"storageState,omitempty"`
}

// Empty reports whether session creation can skip browser initialization.
func (input SessionInitialization) Empty() bool {
	return emptyJSON(input.Targets, "[]") && emptyJSON(input.StorageState)
}

func emptyJSON(raw json.RawMessage, emptyValues ...string) bool {
	value := string(bytes.TrimSpace(raw))
	return value == "" || value == "null" || slices.Contains(emptyValues, value)
}
