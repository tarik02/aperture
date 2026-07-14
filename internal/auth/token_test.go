package auth

import (
	"strings"
	"testing"
)

func TestParseRawToken(t *testing.T) {
	t.Parallel()

	tokenID := "018f1234-0000-7000-8000-000000000001"
	secret := "abc123"
	raw := "apt_" + tokenID + "_" + secret

	gotID, gotSecret, err := ParseRawToken(raw)
	if err != nil {
		t.Fatalf("ParseRawToken() error = %v", err)
	}
	if gotID != tokenID {
		t.Fatalf("token id = %q, want %q", gotID, tokenID)
	}
	if gotSecret != secret {
		t.Fatalf("secret = %q, want %q", gotSecret, secret)
	}
}

func TestParseRawTokenRejectsInvalidFormat(t *testing.T) {
	t.Parallel()

	cases := []string{
		"",
		"bad",
		"apt_onlyprefix",
		"apt_id_",
		"session_018f1234-0000-7000-8000-000000000001_secret",
	}

	for _, raw := range cases {
		if _, _, err := ParseRawToken(raw); err == nil {
			t.Fatalf("ParseRawToken(%q) expected error", raw)
		}
	}
}

func TestGenerateAndVerifySecret(t *testing.T) {
	t.Parallel()

	tokenID := "018f1234-0000-7000-8000-000000000002"
	raw, hash, err := GenerateRawToken(tokenID)
	if err != nil {
		t.Fatalf("GenerateRawToken() error = %v", err)
	}

	if !strings.HasPrefix(raw, "apt_"+tokenID+"_") {
		t.Fatalf("raw token = %q, missing expected prefix", raw)
	}

	_, secret, err := ParseRawToken(raw)
	if err != nil {
		t.Fatalf("ParseRawToken() error = %v", err)
	}
	if !VerifySecret(hash, secret) {
		t.Fatal("VerifySecret() = false, want true")
	}
	if VerifySecret(hash, secret+"x") {
		t.Fatal("VerifySecret() with wrong secret = true, want false")
	}
}

func TestVerifySecretUsesConstantTimePath(t *testing.T) {
	t.Parallel()

	_, hash, err := GenerateRawToken("018f1234-0000-7000-8000-000000000003")
	if err != nil {
		t.Fatalf("GenerateRawToken() error = %v", err)
	}

	if VerifySecret(hash, "not-the-secret") {
		t.Fatal("expected wrong secret to fail verification")
	}
}
