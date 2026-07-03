package session

import (
	"strings"
	"testing"
)

func TestParseCDPTokenAllowsUnderscoreInSecret(t *testing.T) {
	t.Parallel()

	sessionID := "018f1234-0000-7000-8000-000000000001"
	secret := "abc_def"
	raw := "cdp_" + sessionID + "_" + secret

	gotSessionID, gotSecret, err := ParseCDPToken(raw)
	if err != nil {
		t.Fatalf("ParseCDPToken() error = %v", err)
	}
	if gotSessionID != sessionID {
		t.Fatalf("session id = %q, want %q", gotSessionID, sessionID)
	}
	if gotSecret != secret {
		t.Fatalf("secret = %q, want %q", gotSecret, secret)
	}
}

func TestParseCDPTokenRejectsMalformedToken(t *testing.T) {
	t.Parallel()

	if _, _, err := ParseCDPToken("apt_bad"); err == nil {
		t.Fatal("expected malformed token error")
	}
	if _, _, err := ParseCDPToken("cdp_" + strings.Repeat("a", 36)); err == nil {
		t.Fatal("expected missing secret error")
	}
}
