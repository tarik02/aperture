package ids

import (
	"fmt"

	"github.com/google/uuid"
)

// NewUUIDv7 returns a RFC 9562 UUID version 7 string.
func NewUUIDv7() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("generate uuidv7: %w", err)
	}
	return id.String(), nil
}

// ValidateUUIDv7 checks that id is a canonical lowercase UUID version 7 string.
func ValidateUUIDv7(id string) error {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return fmt.Errorf("invalid uuidv7: %w", err)
	}
	if id != parsed.String() {
		return fmt.Errorf("uuid must use canonical hyphenated lowercase form")
	}
	if parsed.Version() != 7 {
		return fmt.Errorf("uuid must be version 7")
	}
	if parsed.Variant() != uuid.RFC4122 {
		return fmt.Errorf("uuid must use RFC 4122 variant")
	}
	return nil
}
