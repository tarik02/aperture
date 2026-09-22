package browser

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
)

const (
	MaxInitialTargets        = 50
	MaxInitialCookies        = 1000
	MaxInitialStorageOrigins = 20
)

// InitialTarget describes a browser target created during session startup.
type InitialTarget struct {
	URL string `json:"url"`
}

// CookieSameSite is a Chromium cookie SameSite value.
type CookieSameSite string

const (
	CookieSameSiteStrict CookieSameSite = "Strict"
	CookieSameSiteLax    CookieSameSite = "Lax"
	CookieSameSiteNone   CookieSameSite = "None"
)

// InitialCookie is a cookie imported while creating a session.
type InitialCookie struct {
	Name     string         `json:"name"`
	Value    string         `json:"value"`
	Domain   string         `json:"domain"`
	Path     string         `json:"path"`
	Expires  *float64       `json:"expires,omitempty"`
	HTTPOnly bool           `json:"httpOnly,omitempty"`
	Secure   bool           `json:"secure,omitempty"`
	SameSite CookieSameSite `json:"sameSite,omitempty"`
}

// LocalStorageEntry is one imported origin-local key and value.
type LocalStorageEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// InitialStorageOrigin contains local storage imported for one HTTP origin.
type InitialStorageOrigin struct {
	Origin       string              `json:"origin"`
	LocalStorage []LocalStorageEntry `json:"localStorage"`
}

// InitialStorageState contains browser storage imported during session startup.
type InitialStorageState struct {
	Cookies []InitialCookie        `json:"cookies"`
	Origins []InitialStorageOrigin `json:"origins"`
}

// SessionInitialization is optional browser state applied during session creation.
type SessionInitialization struct {
	Targets      []InitialTarget      `json:"initialTargets,omitempty"`
	StorageState *InitialStorageState `json:"storageState,omitempty"`
}

// Empty reports whether session creation can skip browser initialization.
func (input SessionInitialization) Empty() bool {
	return len(input.Targets) == 0 && input.StorageState == nil
}

// Validate checks browser initialization before a runtime is started.
func (input SessionInitialization) Validate() error {
	if len(input.Targets) > MaxInitialTargets {
		return fmt.Errorf("initialTargets must contain at most %d entries", MaxInitialTargets)
	}
	for index, target := range input.Targets {
		if err := validateHTTPURL(target.URL); err != nil {
			return fmt.Errorf("initialTargets[%d].url: %w", index, err)
		}
	}
	if input.StorageState == nil {
		return nil
	}
	return input.StorageState.Validate()
}

// Validate checks imported cookies and origin-local storage.
func (state InitialStorageState) Validate() error {
	if len(state.Cookies) > MaxInitialCookies {
		return fmt.Errorf("storageState.cookies must contain at most %d entries", MaxInitialCookies)
	}
	if len(state.Origins) > MaxInitialStorageOrigins {
		return fmt.Errorf("storageState.origins must contain at most %d entries", MaxInitialStorageOrigins)
	}
	cookieKeys := make(map[string]struct{}, len(state.Cookies))
	for index, cookie := range state.Cookies {
		if err := cookie.Validate(); err != nil {
			return fmt.Errorf("storageState.cookies[%d]: %w", index, err)
		}
		key := cookie.Name + "\x00" + strings.ToLower(cookie.Domain) + "\x00" + cookie.Path
		if _, exists := cookieKeys[key]; exists {
			return fmt.Errorf("storageState.cookies[%d]: duplicate cookie", index)
		}
		cookieKeys[key] = struct{}{}
	}

	origins := make(map[string]struct{}, len(state.Origins))
	for index, origin := range state.Origins {
		canonical, err := canonicalHTTPOrigin(origin.Origin)
		if err != nil {
			return fmt.Errorf("storageState.origins[%d]: %w", index, err)
		}
		if err := origin.validateLocalStorage(); err != nil {
			return fmt.Errorf("storageState.origins[%d]: %w", index, err)
		}
		if _, exists := origins[canonical]; exists {
			return fmt.Errorf("storageState.origins[%d]: duplicate origin", index)
		}
		origins[canonical] = struct{}{}
	}
	return nil
}

// Validate checks an imported cookie.
func (cookie InitialCookie) Validate() error {
	if strings.TrimSpace(cookie.Name) == "" {
		return errors.New("name is required")
	}
	if strings.TrimSpace(cookie.Domain) == "" {
		return errors.New("domain is required")
	}
	if !strings.HasPrefix(cookie.Path, "/") {
		return errors.New("path must start with /")
	}
	if cookie.Expires != nil && (math.IsNaN(*cookie.Expires) || math.IsInf(*cookie.Expires, 0) || *cookie.Expires <= 0) {
		return errors.New("expires must be a positive finite Unix timestamp")
	}
	switch cookie.SameSite {
	case "", CookieSameSiteStrict, CookieSameSiteLax, CookieSameSiteNone:
		return nil
	default:
		return errors.New("sameSite must be Strict, Lax, or None")
	}
}

// Validate checks imported local storage for one origin.
func (origin InitialStorageOrigin) Validate() error {
	if _, err := canonicalHTTPOrigin(origin.Origin); err != nil {
		return err
	}
	return origin.validateLocalStorage()
}

func (origin InitialStorageOrigin) validateLocalStorage() error {
	keys := make(map[string]struct{}, len(origin.LocalStorage))
	for index, entry := range origin.LocalStorage {
		if _, exists := keys[entry.Name]; exists {
			return fmt.Errorf("localStorage[%d]: duplicate name", index)
		}
		keys[entry.Name] = struct{}{}
	}
	return nil
}

func canonicalHTTPOrigin(rawOrigin string) (string, error) {
	parsed, err := url.Parse(rawOrigin)
	if err != nil || !validHTTPScheme(parsed.Scheme) || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return "", errors.New("origin must contain only an http or https scheme and host")
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), nil
}

func validateHTTPURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || !validHTTPScheme(parsed.Scheme) || parsed.Host == "" || parsed.User != nil {
		return errors.New("must be an absolute http or https URL without embedded credentials")
	}
	return nil
}

func validHTTPScheme(scheme string) bool {
	return strings.EqualFold(scheme, "http") || strings.EqualFold(scheme, "https")
}
