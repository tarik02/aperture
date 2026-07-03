package sudo

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/aperture/aperture/internal/ids"
)

var (
	ErrInvalidArguments = errors.New("invalid helper arguments")
	ErrInvalidSessionID = errors.New("invalid session id")
	ErrInvalidSnapshot  = errors.New("invalid snapshot id")
)

// MountRequest captures validated mount helper arguments.
type MountRequest struct {
	SessionID      string
	BaseSnapshotID string
	Empty          bool
}

// ParseMountArgs parses aperture-mount-session arguments.
// Usage: aperture-mount-session <session-id> [base-snapshot-id|empty]
func ParseMountArgs(args []string) (MountRequest, error) {
	if len(args) < 1 || len(args) > 2 {
		return MountRequest{}, fmt.Errorf("%w: expected 1 or 2 arguments, got %d", ErrInvalidArguments, len(args))
	}

	sessionID := args[0]
	if err := validateHelperID(sessionID); err != nil {
		return MountRequest{}, fmt.Errorf("%w: %v", ErrInvalidSessionID, err)
	}

	req := MountRequest{SessionID: sessionID}
	if len(args) == 1 {
		req.Empty = true
		return req, nil
	}

	second := args[1]
	if second == "empty" {
		req.Empty = true
		return req, nil
	}
	if err := validateHelperID(second); err != nil {
		return MountRequest{}, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	req.BaseSnapshotID = second
	return req, nil
}

// ParseUnmountArgs parses aperture-unmount-session arguments.
// Usage: aperture-unmount-session <session-id>
func ParseUnmountArgs(args []string) (string, error) {
	if len(args) != 1 {
		return "", fmt.Errorf("%w: expected 1 argument, got %d", ErrInvalidArguments, len(args))
	}

	sessionID := args[0]
	if err := validateHelperID(sessionID); err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidSessionID, err)
	}

	return sessionID, nil
}

func validateHelperID(id string) error {
	if containsWhitespace(id) {
		return fmt.Errorf("id must not contain whitespace")
	}
	return ids.ValidateUUIDv7(id)
}

func containsWhitespace(value string) bool {
	return strings.IndexFunc(value, unicode.IsSpace) >= 0
}
