package auth

import (
	"crypto/sha256"
	"sync"
	"time"
)

const (
	defaultBcryptSuccessCacheEntries  = 1024
	defaultBcryptSuccessCacheInflight = 64
	defaultBcryptSuccessCacheTTL      = 5 * time.Minute
)

// BcryptSuccessCache caches successful bcrypt comparisons without retaining
// the presented secret. The caller remains responsible for database-backed
// authentication checks.
type BcryptSuccessCache struct {
	mu          sync.Mutex
	entries     map[[sha256.Size]byte]time.Time
	inflight    map[[sha256.Size]byte]*bcryptSuccessCacheFlight
	maxEntries  int
	maxInflight int
	ttl         time.Duration
}

type bcryptSuccessCacheFlight struct {
	done       chan struct{}
	result     bool
	panicked   bool
	panicValue any
}

// NewBcryptSuccessCache creates a bounded cache for successful comparisons.
func NewBcryptSuccessCache() *BcryptSuccessCache {
	return &BcryptSuccessCache{
		entries:     make(map[[sha256.Size]byte]time.Time, defaultBcryptSuccessCacheEntries),
		inflight:    make(map[[sha256.Size]byte]*bcryptSuccessCacheFlight, defaultBcryptSuccessCacheInflight),
		maxEntries:  defaultBcryptSuccessCacheEntries,
		maxInflight: defaultBcryptSuccessCacheInflight,
		ttl:         defaultBcryptSuccessCacheTTL,
	}
}

// Verify returns true for a cached or freshly verified bcrypt comparison.
func (c *BcryptSuccessCache) Verify(hash, secret string) bool {
	if c == nil || c.maxEntries <= 0 || c.ttl <= 0 {
		return VerifySecret(hash, secret)
	}
	maxInflight := c.maxInflight
	if maxInflight <= 0 {
		maxInflight = defaultBcryptSuccessCacheInflight
	}

	key := bcryptSuccessCacheKey(hash, secret)
	now := time.Now()

	c.mu.Lock()
	if c.entries == nil {
		c.entries = make(map[[sha256.Size]byte]time.Time, c.maxEntries)
	}
	if c.inflight == nil {
		c.inflight = make(map[[sha256.Size]byte]*bcryptSuccessCacheFlight, maxInflight)
	}
	if expiresAt, ok := c.entries[key]; ok {
		if now.Before(expiresAt) {
			c.mu.Unlock()
			return true
		}
		delete(c.entries, key)
	}
	if flight, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-flight.done
		if flight.panicked {
			panic(flight.panicValue)
		}
		return flight.result
	}
	if len(c.inflight) >= maxInflight {
		c.mu.Unlock()
		return VerifySecret(hash, secret)
	}
	flight := &bcryptSuccessCacheFlight{done: make(chan struct{})}
	c.inflight[key] = flight
	c.mu.Unlock()

	return c.runFlight(key, flight, hash, secret)
}

func (c *BcryptSuccessCache) runFlight(
	key [sha256.Size]byte,
	flight *bcryptSuccessCacheFlight,
	hash string,
	secret string,
) (verified bool) {
	completed := false
	defer func() {
		if !completed {
			panicValue := recover()
			c.finishFlight(key, flight, false, true, panicValue)
			panic(panicValue)
		}
		c.finishFlight(key, flight, verified, false, nil)
	}()

	verified = VerifySecret(hash, secret)
	completed = true
	return verified
}

func (c *BcryptSuccessCache) finishFlight(
	key [sha256.Size]byte,
	flight *bcryptSuccessCacheFlight,
	verified bool,
	panicked bool,
	panicValue any,
) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if verified {
		c.removeExpired(now)
		if len(c.entries) >= c.maxEntries {
			for existingKey := range c.entries {
				delete(c.entries, existingKey)
				break
			}
		}
		c.entries[key] = now.Add(c.ttl)
	}
	flight.result = verified
	flight.panicked = panicked
	flight.panicValue = panicValue
	delete(c.inflight, key)
	close(flight.done)
}

func (c *BcryptSuccessCache) removeExpired(now time.Time) {
	for key, expiresAt := range c.entries {
		if !now.Before(expiresAt) {
			delete(c.entries, key)
		}
	}
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
