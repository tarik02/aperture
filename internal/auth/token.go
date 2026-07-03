package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

const (
	tokenPrefix      = "apt_"
	tokenSecretBytes = 32
)

const (
	AuthoritySystemAdmin = "system_admin"
	AuthorityTenant      = "tenant"
)

// GenerateRawToken creates a new apt_<tokenId>_<secret> value and its bcrypt hash.
func GenerateRawToken(tokenID string) (raw string, hash string, err error) {
	secretBytes := make([]byte, tokenSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", "", fmt.Errorf("generate token secret: %w", err)
	}

	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	raw = fmt.Sprintf("%s%s_%s", tokenPrefix, tokenID, secret)

	hashBytes, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		return "", "", fmt.Errorf("hash token secret: %w", err)
	}

	return raw, string(hashBytes), nil
}

// ParseRawToken splits apt_<tokenId>_<secret> into its parts.
func ParseRawToken(raw string) (tokenID string, secret string, err error) {
	if !strings.HasPrefix(raw, tokenPrefix) {
		return "", "", ErrTokenInvalid
	}

	rest := raw[len(tokenPrefix):]
	underscore := strings.Index(rest, "_")
	if underscore <= 0 {
		return "", "", ErrTokenInvalid
	}

	tokenID = rest[:underscore]
	secret = rest[underscore+1:]
	if tokenID == "" || secret == "" {
		return "", "", ErrTokenInvalid
	}

	return tokenID, secret, nil
}

// VerifySecret compares secret material against a stored bcrypt hash.
func VerifySecret(hash string, secret string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(secret))
	return err == nil
}

// ConstantTimeEqual compares two strings in constant time.
func ConstantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
