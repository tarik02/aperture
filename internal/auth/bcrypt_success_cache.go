package auth

import (
	"crypto/sha256"
	"time"

	"github.com/hashicorp/golang-lru/v2"
)

const (
	bcryptSuccessCacheEntries = 1024
	bcryptSuccessCacheTTL     = 5 * time.Minute
)

// BcryptSuccessCache caches successful comparisons without retaining the secret.
type BcryptSuccessCache struct {
	entries *lru.Cache[[sha256.Size]byte, time.Time]
}

// NewBcryptSuccessCache creates a bounded cache for successful comparisons.
func NewBcryptSuccessCache() *BcryptSuccessCache {
	entries, err := lru.New[[sha256.Size]byte, time.Time](bcryptSuccessCacheEntries)
	if err != nil {
		panic("create bcrypt success cache: " + err.Error())
	}
	return &BcryptSuccessCache{entries: entries}
}

// Verify returns true for a cached or freshly verified bcrypt comparison.
func (c *BcryptSuccessCache) Verify(hash, secret string) bool {
	if c == nil {
		return VerifySecret(hash, secret)
	}

	key := bcryptSuccessCacheKey(hash, secret)
	now := time.Now()
	expiresAt, cached := c.entries.Get(key)
	if cached && now.Before(expiresAt) {
		return true
	}
	if cached {
		c.entries.Remove(key)
	}

	if !VerifySecret(hash, secret) {
		return false
	}

	c.entries.Add(key, time.Now().Add(bcryptSuccessCacheTTL))
	return true
}

func bcryptSuccessCacheKey(hash, secret string) [sha256.Size]byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte(hash))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(secret))

	var key [sha256.Size]byte
	copy(key[:], digest.Sum(nil))
	return key
}
