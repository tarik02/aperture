package browser

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// RuntimeEnvValues are written for browser-session-wrapper consumption.
type RuntimeEnvValues struct {
	SessionID          string
	MergedUserDataDir  string
	DownloadsDir       string
	CacheDir           string
	ArtifactsDir       string
	CDPPort            int
	BrowserExecutable  string
	BrowserDefaultArgs []string
	BrowserExtraArgs   []string
}

// RenderRuntimeEnv renders a systemd EnvironmentFile body.
func RenderRuntimeEnv(values RuntimeEnvValues) ([]byte, error) {
	if strings.TrimSpace(values.SessionID) == "" {
		return nil, fmt.Errorf("session id is required")
	}
	if strings.TrimSpace(values.MergedUserDataDir) == "" {
		return nil, fmt.Errorf("merged user data dir is required")
	}
	if strings.TrimSpace(values.DownloadsDir) == "" {
		return nil, fmt.Errorf("downloads dir is required")
	}
	if strings.TrimSpace(values.CacheDir) == "" {
		return nil, fmt.Errorf("cache dir is required")
	}
	if strings.TrimSpace(values.ArtifactsDir) == "" {
		return nil, fmt.Errorf("artifacts dir is required")
	}
	if values.CDPPort <= 0 || values.CDPPort > 65535 {
		return nil, fmt.Errorf("cdp port must be between 1 and 65535")
	}
	if strings.TrimSpace(values.BrowserExecutable) == "" {
		return nil, fmt.Errorf("browser executable is required")
	}

	defaultArgs, err := encodeArgVector(values.BrowserDefaultArgs)
	if err != nil {
		return nil, fmt.Errorf("encode default args: %w", err)
	}
	extraArgs, err := encodeArgVector(values.BrowserExtraArgs)
	if err != nil {
		return nil, fmt.Errorf("encode extra args: %w", err)
	}

	lines := []string{
		"APERTURE_SESSION_ID=" + shellQuote(values.SessionID),
		"MERGED_USER_DATA_DIR=" + shellQuote(values.MergedUserDataDir),
		"DOWNLOADS_DIR=" + shellQuote(values.DownloadsDir),
		"CACHE_DIR=" + shellQuote(values.CacheDir),
		"ARTIFACTS_DIR=" + shellQuote(values.ArtifactsDir),
		"CDP_PORT=" + strconv.Itoa(values.CDPPort),
		"BROWSER_EXECUTABLE=" + shellQuote(values.BrowserExecutable),
		"BROWSER_DEFAULT_ARGS=" + defaultArgs,
		"BROWSER_EXTRA_ARGS=" + extraArgs,
	}

	return []byte(strings.Join(lines, "\n") + "\n"), nil
}

// WriteRuntimeEnv atomically writes the runtime env file for a session.
func WriteRuntimeEnv(path string, values RuntimeEnvValues) error {
	body, err := RenderRuntimeEnv(values)
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir runtime env dir: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".session-env-*")
	if err != nil {
		return fmt.Errorf("create temp runtime env: %w", err)
	}
	tmpPath := tmp.Name()

	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	if _, err := tmp.Write(body); err != nil {
		cleanup()
		return fmt.Errorf("write runtime env: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("chmod runtime env: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync runtime env: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close runtime env: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("rename runtime env: %w", err)
	}

	return nil
}

// ParseRuntimeEnv parses a rendered runtime env file body.
func ParseRuntimeEnv(body []byte) (RuntimeEnvValues, error) {
	values := RuntimeEnvValues{}
	lines := bytes.Split(bytes.TrimSpace(body), []byte("\n"))

	for _, line := range lines {
		key, val, ok := strings.Cut(string(line), "=")
		if !ok {
			return RuntimeEnvValues{}, fmt.Errorf("invalid env line: %q", line)
		}

		switch key {
		case "APERTURE_SESSION_ID", "MERGED_USER_DATA_DIR", "DOWNLOADS_DIR", "CACHE_DIR", "ARTIFACTS_DIR", "BROWSER_EXECUTABLE":
			unquoted, err := shellUnquote(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("unquote %s: %w", key, err)
			}
			assignRuntimeString(&values, key, unquoted)
		case "CDP_PORT":
			port, err := strconv.Atoi(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("parse cdp port: %w", err)
			}
			values.CDPPort = port
		case "BROWSER_DEFAULT_ARGS":
			args, err := decodeArgVector(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("decode default args: %w", err)
			}
			values.BrowserDefaultArgs = args
		case "BROWSER_EXTRA_ARGS":
			args, err := decodeArgVector(val)
			if err != nil {
				return RuntimeEnvValues{}, fmt.Errorf("decode extra args: %w", err)
			}
			values.BrowserExtraArgs = args
		default:
			return RuntimeEnvValues{}, fmt.Errorf("unexpected env key: %s", key)
		}
	}

	return values, nil
}

func assignRuntimeString(values *RuntimeEnvValues, key, value string) {
	switch key {
	case "APERTURE_SESSION_ID":
		values.SessionID = value
	case "MERGED_USER_DATA_DIR":
		values.MergedUserDataDir = value
	case "DOWNLOADS_DIR":
		values.DownloadsDir = value
	case "CACHE_DIR":
		values.CacheDir = value
	case "ARTIFACTS_DIR":
		values.ArtifactsDir = value
	case "BROWSER_EXECUTABLE":
		values.BrowserExecutable = value
	}
}

func encodeArgVector(args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	data, err := json.Marshal(args)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func decodeArgVector(encoded string) ([]string, error) {
	if encoded == "" {
		return nil, nil
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	var args []string
	if err := json.Unmarshal(data, &args); err != nil {
		return nil, err
	}
	return args, nil
}

func shellQuote(value string) string {
	if value == "" {
		return `""`
	}
	if !strings.ContainsAny(value, " \t\n\"'\\$`") {
		return value
	}
	return strconv.Quote(value)
}

func shellUnquote(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return strconv.Unquote(value)
	}
	return value, nil
}
