package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"github.com/aperture/aperture/internal/auth"
)

const mediaTokenSecretBytes = 32

// GenerateMediaToken creates media_<sessionId>_<secret> and its stored hash.
func GenerateMediaToken(sessionID string) (raw string, hash string, err error) {
	secretBytes := make([]byte, mediaTokenSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", "", fmt.Errorf("generate media token secret: %w", err)
	}

	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	raw = fmt.Sprintf("media_%s_%s", sessionID, secret)

	hashBytes, err := auth.HashSecret(secret)
	if err != nil {
		return "", "", err
	}

	return raw, hashBytes, nil
}

// ParseMediaToken splits media_<sessionId>_<secret> into session id and secret.
func ParseMediaToken(raw string) (sessionID string, secret string, err error) {
	const prefix = "media_"
	if len(raw) <= len(prefix) || raw[:len(prefix)] != prefix {
		return "", "", fmt.Errorf("invalid media token format")
	}

	rest := raw[len(prefix):]
	const uuidLength = 36
	if len(rest) <= uuidLength+1 || rest[uuidLength] != '_' {
		return "", "", fmt.Errorf("invalid media token format")
	}

	sessionID = rest[:uuidLength]
	secret = rest[uuidLength+1:]
	if sessionID == "" || secret == "" {
		return "", "", fmt.Errorf("invalid media token format")
	}
	return sessionID, secret, nil
}

// VerifyMediaToken compares secret material against a stored hash.
func VerifyMediaToken(hash string, secret string) bool {
	return auth.VerifySecret(hash, secret)
}
