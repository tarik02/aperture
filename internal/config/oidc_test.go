package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

func loadWithOIDCProvider(t *testing.T, secretLines string) (Config, error) {
	t.Helper()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "aperture.toml")
	contents := `
store_root = "` + filepath.Join(dir, "store") + `"
runtime_root = "` + filepath.Join(dir, "runtime") + `"
external_base_url = "https://file.example.test"

[channels.chromium]
executable = "/usr/bin/chromium"

[[oidc_providers]]
id = "company"
display_name = "Company account"
issuer_url = "https://accounts.example.test"
client_id = "aperture"
` + secretLines + `
`
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	flags := viper.New()
	flags.Set("config", configPath)
	return Load(flags)
}

func writeSecretFile(t *testing.T, contents string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "client-secret")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	return path
}

func TestLoadReadsOIDCClientSecretFile(t *testing.T) {
	secretPath := writeSecretFile(t, "s3cret \n")

	cfg, err := loadWithOIDCProvider(t, `client_secret_file = "`+secretPath+`"`)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	provider := cfg.OIDCProviders[0]
	if provider.ClientSecret != "s3cret " {
		t.Fatalf("client secret = %q, want file contents without the trailing newline", provider.ClientSecret)
	}
	if provider.ClientSecretFile != "" {
		t.Fatalf("client secret file = %q, want cleared after resolving", provider.ClientSecretFile)
	}
	if err := Validate(cfg); err != nil {
		t.Fatalf("validate resolved config: %v", err)
	}
}

func TestLoadRejectsInvalidOIDCClientSecretSources(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		secretLines func(t *testing.T) string
		wantError   string
	}{
		{
			name: "both set",
			secretLines: func(t *testing.T) string {
				return "client_secret = \"inline\"\nclient_secret_file = \"" + writeSecretFile(t, "s3cret") + "\""
			},
			wantError: "oidc_providers[0] must set only one of client_secret and client_secret_file",
		},
		{
			name:        "neither set",
			secretLines: func(*testing.T) string { return "" },
			wantError:   "oidc_providers[0].client_secret or client_secret_file is required",
		},
		{
			name: "relative path",
			secretLines: func(*testing.T) string {
				return `client_secret_file = "client-secret"`
			},
			wantError: "oidc_providers[0].client_secret_file must be an absolute path",
		},
		{
			name: "missing file",
			secretLines: func(t *testing.T) string {
				return `client_secret_file = "` + filepath.Join(t.TempDir(), "missing") + `"`
			},
			wantError: "oidc_providers[0].client_secret_file: open ",
		},
		{
			name: "empty file",
			secretLines: func(t *testing.T) string {
				return `client_secret_file = "` + writeSecretFile(t, " \n") + `"`
			},
			wantError: "is empty",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := loadWithOIDCProvider(t, testCase.secretLines(t))
			if err == nil {
				t.Fatal("load config succeeded, want error")
			}
			if !strings.Contains(err.Error(), testCase.wantError) {
				t.Fatalf("error = %q, want it to contain %q", err, testCase.wantError)
			}
		})
	}
}
