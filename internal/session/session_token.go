package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"github.com/aperture/aperture/internal/auth"
)

const sessionTokenSecretBytes = 32

// GenerateSessionToken creates aps_<sessionId>_<secret> and its stored hash.
func GenerateSessionToken(sessionID string) (raw string, hash string, err error) {
	secretBytes := make([]byte, sessionTokenSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", "", fmt.Errorf("generate session token secret: %w", err)
	}

	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	raw = fmt.Sprintf("aps_%s_%s", sessionID, secret)

	hashBytes, err := auth.HashSecret(secret)
	if err != nil {
		return "", "", err
	}

	return raw, hashBytes, nil
}

// ParseSessionToken splits aps_<sessionId>_<secret> into session id and secret.
func ParseSessionToken(raw string) (sessionID string, secret string, err error) {
	const prefix = "aps_"
	if len(raw) <= len(prefix) || raw[:len(prefix)] != prefix {
		return "", "", fmt.Errorf("invalid session token format")
	}

	rest := raw[len(prefix):]
	const uuidLength = 36
	if len(rest) <= uuidLength+1 || rest[uuidLength] != '_' {
		return "", "", fmt.Errorf("invalid session token format")
	}

	sessionID = rest[:uuidLength]
	secret = rest[uuidLength+1:]
	if sessionID == "" || secret == "" {
		return "", "", fmt.Errorf("invalid session token format")
	}
	return sessionID, secret, nil
}

// VerifySessionToken compares secret material against a stored hash.
func VerifySessionToken(hash string, secret string) bool {
	return auth.VerifySecret(hash, secret)
}
