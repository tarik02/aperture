package browser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteDownloadPreferencesSetsDownloadDirectory(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	merged := filepath.Join(root, "merged")
	downloads := filepath.Join(root, "downloads")
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		t.Fatalf("mkdir downloads: %v", err)
	}

	if err := WriteDownloadPreferences(merged, downloads); err != nil {
		t.Fatalf("WriteDownloadPreferences() error = %v", err)
	}

	prefsPath := filepath.Join(merged, "Default", "Preferences")
	body, err := os.ReadFile(prefsPath)
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}

	var parsed struct {
		Download struct {
			DefaultDirectory  string `json:"default_directory"`
			PromptForDownload bool   `json:"prompt_for_download"`
		} `json:"download"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("unmarshal preferences: %v", err)
	}
	if parsed.Download.DefaultDirectory != downloads {
		t.Fatalf("default_directory = %q, want %q", parsed.Download.DefaultDirectory, downloads)
	}
	if parsed.Download.PromptForDownload {
		t.Fatal("expected prompt_for_download=false")
	}
}

func TestWriteDownloadPreferencesPreservesExistingKeys(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	merged := filepath.Join(root, "merged")
	downloads := filepath.Join(root, "downloads")
	profileDir := filepath.Join(merged, "Default")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatalf("mkdir profile: %v", err)
	}
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		t.Fatalf("mkdir downloads: %v", err)
	}

	existing := map[string]any{
		"profile": map[string]any{
			"name": "Default",
		},
		"intl": map[string]any{
			"accept_languages": "en-US,en",
		},
	}
	body, err := json.Marshal(existing)
	if err != nil {
		t.Fatalf("marshal existing: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "Preferences"), body, 0o644); err != nil {
		t.Fatalf("write existing preferences: %v", err)
	}

	if err := WriteDownloadPreferences(merged, downloads); err != nil {
		t.Fatalf("WriteDownloadPreferences() error = %v", err)
	}

	updated, err := os.ReadFile(filepath.Join(profileDir, "Preferences"))
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(updated, &parsed); err != nil {
		t.Fatalf("unmarshal preferences: %v", err)
	}

	profile, ok := parsed["profile"].(map[string]any)
	if !ok || profile["name"] != "Default" {
		t.Fatalf("profile preferences lost: %#v", parsed["profile"])
	}
	intl, ok := parsed["intl"].(map[string]any)
	if !ok || intl["accept_languages"] != "en-US,en" {
		t.Fatalf("intl preferences lost: %#v", parsed["intl"])
	}
	download, ok := parsed["download"].(map[string]any)
	if !ok || download["default_directory"] != downloads {
		t.Fatalf("download preferences missing: %#v", parsed["download"])
	}
	if download["prompt_for_download"] != false {
		t.Fatalf("prompt_for_download = %#v", download["prompt_for_download"])
	}
}
