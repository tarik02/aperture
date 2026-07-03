package auth

import (
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// HashSecret returns a bcrypt hash for secret material.
func HashSecret(secret string) (string, error) {
	hashBytes, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash secret: %w", err)
	}
	return string(hashBytes), nil
}
