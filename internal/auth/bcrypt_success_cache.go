package auth

import (
	"crypto/sha256"
	"sync"
	"time"
)

const (
	bcryptSuccessCacheEntries = 1024
	bcryptSuccessCacheTTL     = 5 * time.Minute
)

// BcryptSuccessCache caches successful comparisons without retaining the secret.
type BcryptSuccessCache struct {
	mu      sync.Mutex
	entries map[[sha256.Size]byte]time.Time
}

// NewBcryptSuccessCache creates a bounded cache for successful comparisons.
func NewBcryptSuccessCache() *BcryptSuccessCache {
	return &BcryptSuccessCache{entries: make(map[[sha256.Size]byte]time.Time)}
}

// Verify returns true for a cached or freshly verified bcrypt comparison.
func (c *BcryptSuccessCache) Verify(hash, secret string) bool {
	if c == nil {
		return VerifySecret(hash, secret)
	}

	key := bcryptSuccessCacheKey(hash, secret)
	now := time.Now()
	c.mu.Lock()
	expiresAt, cached := c.entries[key]
	if cached && now.Before(expiresAt) {
		c.mu.Unlock()
		return true
	}
	delete(c.entries, key)
	c.mu.Unlock()

	if !VerifySecret(hash, secret) {
		return false
	}

	now = time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[[sha256.Size]byte]time.Time)
	}
	for existingKey, existingExpiry := range c.entries {
		if !now.Before(existingExpiry) {
			delete(c.entries, existingKey)
		}
	}
	if len(c.entries) >= bcryptSuccessCacheEntries {
		for existingKey := range c.entries {
			delete(c.entries, existingKey)
			break
		}
	}
	c.entries[key] = now.Add(bcryptSuccessCacheTTL)
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
