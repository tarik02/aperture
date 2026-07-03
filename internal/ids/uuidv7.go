package ids

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// NewUUIDv7 returns a RFC 9562 UUID version 7 string.
func NewUUIDv7() (string, error) {
	var b [16]byte

	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)

	var randPart [10]byte
	if _, err := rand.Read(randPart[:]); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}

	b[6] = (randPart[0] & 0x0f) | 0x70
	b[7] = randPart[1]
	b[8] = (randPart[2] & 0x3f) | 0x80
	b[9] = randPart[3]
	copy(b[10:], randPart[4:])

	return formatUUID(b), nil
}

func formatUUID(b [16]byte) string {
	hexBytes := hex.EncodeToString(b[:])
	return fmt.Sprintf(
		"%s-%s-%s-%s-%s",
		hexBytes[0:8],
		hexBytes[8:12],
		hexBytes[12:16],
		hexBytes[16:20],
		hexBytes[20:32],
	)
}
