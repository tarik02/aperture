package browser

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/sessionfiles"
)

func writeSessionUpload(t *testing.T, filesDir, name string, size int) {
	t.Helper()
	uploads := filepath.Join(filesDir, "uploads")
	if err := os.MkdirAll(uploads, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploads, name), make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSetInputFilesCodeChecksSessionFileSizesWithoutHostPaths(t *testing.T) {
	t.Parallel()

	filesDir := t.TempDir()
	writeSessionUpload(t, filesDir, "demo.zip", 1234)

	code, err := setInputFilesCode(filesDir, map[string]any{"target": "f1e12", "paths": []any{"uploads/demo.zip"}})
	if err != nil {
		t.Fatalf("setInputFilesCode() error = %v", err)
	}
	for _, want := range []string{
		`page.locator("aria-ref=f1e12")`,
		`setInputFiles(["uploads/demo.zip"])`,
		`[{"name":"demo.zip","size":1234}]`,
	} {
		if !strings.Contains(code, want) {
			t.Errorf("code does not contain %s:\n%s", want, code)
		}
	}
	if strings.Contains(code, filesDir) {
		t.Errorf("code contains the host files root %s:\n%s", filesDir, code)
	}
}

func TestSetInputFilesCodeKeepsSelectors(t *testing.T) {
	t.Parallel()

	code, err := setInputFilesCode(t.TempDir(), map[string]any{"target": "#downloadsfiledata", "paths": []any{}})
	if err != nil {
		t.Fatalf("setInputFilesCode() error = %v", err)
	}
	if !strings.Contains(code, `page.locator("#downloadsfiledata")`) {
		t.Errorf("code does not locate the selector:\n%s", code)
	}
}

func TestSetInputFilesCodeRejectsFilesOutsideTheSession(t *testing.T) {
	t.Parallel()

	filesDir := t.TempDir()
	writeSessionUpload(t, filesDir, ".pending", 1)

	cases := map[string]error{
		"../etc/passwd":    sessionfiles.ErrInvalidPath,
		"/etc/passwd":      sessionfiles.ErrInvalidPath,
		"uploads/.pending": sessionfiles.ErrInvalidPath,
		"uploads/missing":  sessionfiles.ErrNotFound,
	}
	for relative, want := range cases {
		_, err := setInputFilesCode(filesDir, map[string]any{"target": "#input", "paths": []any{relative}})
		if !errors.Is(err, want) {
			t.Errorf("setInputFilesCode(%q) error = %v, want %v", relative, err, want)
		}
	}
}
