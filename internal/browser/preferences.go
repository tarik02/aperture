package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/renameio/v2"
)

// WriteDownloadPreferences updates Chromium Default/Preferences for per-session downloads.
func WriteDownloadPreferences(mergedUserDataDir, downloadsDir string) error {
	if mergedUserDataDir == "" {
		return fmt.Errorf("merged user data dir is required")
	}
	if downloadsDir == "" {
		return fmt.Errorf("downloads dir is required")
	}

	profileDir := filepath.Join(mergedUserDataDir, "Default")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		return fmt.Errorf("mkdir chromium profile: %w", err)
	}

	prefsPath := filepath.Join(profileDir, "Preferences")
	prefs := make(map[string]any)

	if data, err := os.ReadFile(prefsPath); err == nil {
		if err := json.Unmarshal(data, &prefs); err != nil {
			return fmt.Errorf("parse existing preferences: %w", err)
		}
	}

	download := map[string]any{}
	if raw, ok := prefs["download"].(map[string]any); ok {
		for key, value := range raw {
			download[key] = value
		}
	}
	download["default_directory"] = downloadsDir
	download["prompt_for_download"] = false
	prefs["download"] = download

	body, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal chromium preferences: %w", err)
	}
	body = append(body, '\n')

	if err := renameio.WriteFile(prefsPath, body, 0o644, renameio.WithStaticPermissions(0o644)); err != nil {
		return fmt.Errorf("write preferences: %w", err)
	}

	return nil
}
