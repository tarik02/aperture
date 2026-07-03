package session

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"github.com/aperture/aperture/internal/auth"
)

const cdpTokenSecretBytes = 32

// GenerateCDPToken creates cdp_<sessionId>_<secret> and its stored hash.
func GenerateCDPToken(sessionID string) (raw string, hash string, err error) {
	secretBytes := make([]byte, cdpTokenSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", "", fmt.Errorf("generate cdp token secret: %w", err)
	}

	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	raw = fmt.Sprintf("cdp_%s_%s", sessionID, secret)

	hashBytes, err := auth.HashSecret(secret)
	if err != nil {
		return "", "", err
	}

	return raw, hashBytes, nil
}

// ParseCDPToken splits cdp_<sessionId>_<secret> into session id and secret.
func ParseCDPToken(raw string) (sessionID string, secret string, err error) {
	const prefix = "cdp_"
	if len(raw) <= len(prefix) || raw[:len(prefix)] != prefix {
		return "", "", fmt.Errorf("invalid cdp token format")
	}

	rest := raw[len(prefix):]
	const uuidLength = 36
	if len(rest) <= uuidLength+1 || rest[uuidLength] != '_' {
		return "", "", fmt.Errorf("invalid cdp token format")
	}

	sessionID = rest[:uuidLength]
	secret = rest[uuidLength+1:]
	if sessionID == "" || secret == "" {
		return "", "", fmt.Errorf("invalid cdp token format")
	}
	return sessionID, secret, nil
}

// VerifyCDPToken compares secret material against a stored hash.
func VerifyCDPToken(hash string, secret string) bool {
	return auth.VerifySecret(hash, secret)
}
