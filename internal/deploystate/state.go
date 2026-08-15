package deploystate

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/google/renameio/v2"
)

const (
	RoleActive   = "active"
	RoleInactive = "inactive"
)

// State is the persistent blue-green deployment state.
type State struct {
	ActiveColor   string `json:"activeColor"`
	BlueURL       string `json:"blueURL"`
	GreenURL      string `json:"greenURL"`
	ActiveVersion string `json:"activeVersion"`
	UpdatedAt     string `json:"updatedAt"`
}

// Service reads and writes deployment state.
type Service struct {
	path     string
	blueURL  string
	greenURL string
	now      func() time.Time
}

// New constructs a deployment-state service from runtime config.
func New(cfg config.Config) *Service {
	return &Service{
		path:     cfg.DeployStatePath,
		blueURL:  cfg.DeployBlueURL,
		greenURL: cfg.DeployGreenURL,
		now:      time.Now,
	}
}

// Load reads deployment state from disk.
func (s *Service) Load() (State, error) {
	body, err := os.ReadFile(s.path)
	if err != nil {
		return State{}, err
	}

	var state State
	if err := json.Unmarshal(body, &state); err != nil {
		return State{}, fmt.Errorf("decode deployment state: %w", err)
	}
	if err := Validate(state); err != nil {
		return State{}, err
	}
	return state, nil
}

// EnsureActive initializes deployment state when it does not exist.
func (s *Service) EnsureActive(color, version string) (State, error) {
	state, err := s.Load()
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return State{}, err
	}
	return s.MarkActive(color, version)
}

// MarkActive atomically records color as the active API color.
func (s *Service) MarkActive(color, version string) (State, error) {
	color = strings.ToLower(strings.TrimSpace(color))
	if !IsColor(color) {
		return State{}, fmt.Errorf("deployment color must be blue or green")
	}

	state := State{
		ActiveColor:   color,
		BlueURL:       s.blueURL,
		GreenURL:      s.greenURL,
		ActiveVersion: version,
		UpdatedAt:     s.now().UTC().Format(time.RFC3339Nano),
	}
	if err := Validate(state); err != nil {
		return State{}, err
	}

	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return State{}, fmt.Errorf("encode deployment state: %w", err)
	}
	body = append(body, '\n')

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return State{}, fmt.Errorf("mkdir deployment state dir: %w", err)
	}
	if err := renameio.WriteFile(s.path, body, 0o600, renameio.WithStaticPermissions(0o600)); err != nil {
		return State{}, fmt.Errorf("write deployment state: %w", err)
	}
	return state, nil
}

// Role returns the process role for color under state.
func Role(state State, color string) string {
	if strings.EqualFold(state.ActiveColor, strings.TrimSpace(color)) {
		return RoleActive
	}
	return RoleInactive
}

// ActiveURL returns the URL for the active API color.
func ActiveURL(state State) (string, error) {
	return URLForColor(state, state.ActiveColor)
}

// CandidateURL returns the URL for the inactive API color.
func CandidateURL(state State) (string, error) {
	color, err := CandidateColor(state.ActiveColor)
	if err != nil {
		return "", err
	}
	return URLForColor(state, color)
}

// CandidateColor returns the opposite blue-green color.
func CandidateColor(currentColor string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(currentColor)) {
	case config.DeployColorBlue:
		return config.DeployColorGreen, nil
	case config.DeployColorGreen:
		return config.DeployColorBlue, nil
	default:
		return "", fmt.Errorf("deployment color must be blue or green")
	}
}

// URLForColor returns the configured API URL for color.
func URLForColor(state State, color string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(color)) {
	case config.DeployColorBlue:
		return state.BlueURL, nil
	case config.DeployColorGreen:
		return state.GreenURL, nil
	default:
		return "", fmt.Errorf("deployment color must be blue or green")
	}
}

// Validate checks deployment state loaded from disk.
func Validate(state State) error {
	var errs []error
	if !IsColor(state.ActiveColor) {
		errs = append(errs, errors.New("activeColor must be blue or green"))
	}
	errs = append(errs, validateURL("blueURL", state.BlueURL)...)
	errs = append(errs, validateURL("greenURL", state.GreenURL)...)
	if strings.TrimSpace(state.UpdatedAt) == "" {
		errs = append(errs, errors.New("updatedAt is required"))
	} else if _, err := time.Parse(time.RFC3339Nano, state.UpdatedAt); err != nil {
		errs = append(errs, fmt.Errorf("updatedAt must be RFC3339Nano: %w", err))
	}
	return errors.Join(errs...)
}

// IsColor reports whether color is a valid deployment color.
func IsColor(color string) bool {
	switch strings.ToLower(strings.TrimSpace(color)) {
	case config.DeployColorBlue, config.DeployColorGreen:
		return true
	default:
		return false
	}
}

func validateURL(name, value string) []error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return []error{fmt.Errorf("%s is required", name)}
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return []error{fmt.Errorf("%s: %w", name, err)}
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return []error{fmt.Errorf("%s must include scheme and host", name)}
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return []error{fmt.Errorf("%s scheme must be http or https", name)}
	}
	return nil
}
