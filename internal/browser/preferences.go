package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/renameio/v2"
)

// WriteProfilePreferences updates Chromium Default/Preferences for supervised sessions.
func WriteProfilePreferences(mergedUserDataDir, downloadsDir string) error {
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

	profile := map[string]any{}
	if raw, ok := prefs["profile"].(map[string]any); ok {
		for key, value := range raw {
			profile[key] = value
		}
	}
	profile["password_manager_enabled"] = false
	profile["password_manager_leak_detection"] = false
	contentSettings := map[string]any{}
	if raw, ok := profile["default_content_setting_values"].(map[string]any); ok {
		for key, value := range raw {
			contentSettings[key] = value
		}
	}
	contentSettings["notifications"] = 2
	profile["default_content_setting_values"] = contentSettings
	prefs["profile"] = profile

	autofill := map[string]any{}
	if raw, ok := prefs["autofill"].(map[string]any); ok {
		for key, value := range raw {
			autofill[key] = value
		}
	}
	autofill["profile_enabled"] = false
	autofill["credit_card_enabled"] = false
	prefs["autofill"] = autofill

	session := map[string]any{}
	if raw, ok := prefs["session"].(map[string]any); ok {
		for key, value := range raw {
			session[key] = value
		}
	}
	session["restore_on_startup"] = 1
	prefs["session"] = session

	browser := map[string]any{}
	if raw, ok := prefs["browser"].(map[string]any); ok {
		for key, value := range raw {
			browser[key] = value
		}
	}
	browser["check_default_browser"] = false
	prefs["browser"] = browser

	signin := map[string]any{}
	if raw, ok := prefs["signin"].(map[string]any); ok {
		for key, value := range raw {
			signin[key] = value
		}
	}
	signin["allowed"] = false
	prefs["signin"] = signin

	syncPromo := map[string]any{}
	if raw, ok := prefs["sync_promo"].(map[string]any); ok {
		for key, value := range raw {
			syncPromo[key] = value
		}
	}
	syncPromo["show_on_first_run_allowed"] = false
	prefs["sync_promo"] = syncPromo

	translate := map[string]any{}
	if raw, ok := prefs["translate"].(map[string]any); ok {
		for key, value := range raw {
			translate[key] = value
		}
	}
	translate["enabled"] = false
	prefs["translate"] = translate

	prefs["credentials_enable_service"] = false

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
