package ids

import (
	"testing"
)

func TestNewUUIDv7Format(t *testing.T) {
	t.Parallel()

	id, err := NewUUIDv7()
	if err != nil {
		t.Fatalf("NewUUIDv7() error = %v", err)
	}
	if err := ValidateUUIDv7(id); err != nil {
		t.Fatalf("ValidateUUIDv7(%q) error = %v", id, err)
	}
}

func TestValidateUUIDv7RejectsInvalid(t *testing.T) {
	t.Parallel()

	cases := []string{
		"",
		"not-a-uuid",
		"018f1234-0000-6000-8000-000000000000",
		"018f1234-0000-7000-0000-000000000000",
		"018f1234-0000-7000-8000-00000000000g",
		"018f123400007000800000000000000000",
		"018f1234-0000-7000-8000-000000000000 ",
		" 018f1234-0000-7000-8000-000000000000",
		"018f1234-0000-7000-8000-0000000000000",
		"018F1234-0000-7000-8000-000000000000",
		"018f1234_0000_7000_8000_000000000000",
	}

	for _, id := range cases {
		if err := ValidateUUIDv7(id); err == nil {
			t.Fatalf("ValidateUUIDv7(%q) expected error", id)
		}
	}
}

func TestValidateUUIDv7AcceptsCanonicalExample(t *testing.T) {
	t.Parallel()

	id := "018f1234-0000-7000-8000-000000000000"
	if err := ValidateUUIDv7(id); err != nil {
		t.Fatalf("ValidateUUIDv7(%q) error = %v", id, err)
	}
}
