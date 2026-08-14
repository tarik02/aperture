package deploystate

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/fsnotify/fsnotify"
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

	mu         sync.RWMutex
	cached     State
	cachedErr  error
	cacheValid bool
	watcher    *watcherState
	closed     bool
	closeDone  chan struct{}
	closeErr   error
}

type watcherState struct {
	watcher     *fsnotify.Watcher
	done        chan struct{}
	directories map[string]struct{}
	targets     map[string]struct{}
	parents     map[string]struct{}
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

// Load returns deployment state, refreshing the cache when needed.
func (s *Service) Load() (State, error) {
	s.mu.RLock()
	if s.cacheValid && s.watcher != nil && !s.closed {
		state, err := s.cached, s.cachedErr
		s.mu.RUnlock()
		return state, err
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cacheValid && s.watcher != nil && !s.closed {
		return s.cached, s.cachedErr
	}
	if s.closed {
		return s.read()
	}
	if s.watcher == nil {
		s.startWatcherLocked()
	}

	state, err := s.read()
	if s.watcher != nil {
		s.cached = state
		s.cachedErr = err
		s.cacheValid = true
	} else {
		s.invalidateLocked()
	}
	return state, err
}

func (s *Service) read() (State, error) {
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
	s.mu.Lock()
	defer s.mu.Unlock()

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
	if s.closed {
		return state, nil
	}
	if s.watcher == nil {
		s.startWatcherLocked()
	}
	if s.watcher != nil {
		s.cached = state
		s.cachedErr = nil
		s.cacheValid = true
	} else {
		s.invalidateLocked()
	}
	return state, nil
}

// Close stops the deployment state watcher.
func (s *Service) Close() error {
	s.mu.Lock()
	if s.closed {
		done := s.closeDone
		s.mu.Unlock()
		if done != nil {
			<-done
		}
		s.mu.RLock()
		err := s.closeErr
		s.mu.RUnlock()
		return err
	}
	s.closed = true
	watcher := s.watcher
	s.watcher = nil
	s.invalidateLocked()
	s.closeDone = make(chan struct{})
	s.mu.Unlock()
	var err error
	if watcher != nil {
		err = watcher.watcher.Close()
		<-watcher.done
	}
	s.mu.Lock()
	s.closeErr = err
	close(s.closeDone)
	s.mu.Unlock()
	return err
}

func (s *Service) startWatcherLocked() {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return
	}
	state := &watcherState{
		watcher:     watcher,
		done:        make(chan struct{}),
		directories: make(map[string]struct{}),
		targets:     make(map[string]struct{}),
		parents:     make(map[string]struct{}),
	}
	if !s.reconcileWatcherLocked(state, false) {
		_ = watcher.Close()
		return
	}
	s.watcher = state
	go s.watch(state)
}

func (s *Service) watch(state *watcherState) {
	defer close(state.done)
	for {
		select {
		case event, ok := <-state.watcher.Events:
			if !ok {
				s.failWatcher(state)
				return
			}
			s.handleWatcherEvent(state, event)
		case _, ok := <-state.watcher.Errors:
			if !ok {
				s.failWatcher(state)
				return
			}
			s.failWatcher(state)
			return
		}
	}
}

func (s *Service) handleWatcherEvent(watcher *watcherState, event fsnotify.Event) {
	var closeWatcher *watcherState
	s.mu.Lock()
	if s.closed || s.watcher != watcher {
		s.mu.Unlock()
		return
	}
	name := filepath.Clean(event.Name)
	_, targetEvent := watcher.targets[name]
	_, parentEvent := watcher.parents[name]
	if parentEvent && event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
		for directory := range watcher.directories {
			if !pathWithin(directory, name) {
				continue
			}
			_ = watcher.watcher.Remove(directory)
			delete(watcher.directories, directory)
		}
	}
	rebuild := parentEvent && event.Op&(fsnotify.Remove|fsnotify.Rename) != 0
	if !s.reconcileWatcherLocked(watcher, rebuild) {
		s.watcher = nil
		s.invalidateLocked()
		closeWatcher = watcher
	} else if (targetEvent || parentEvent) && event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename|fsnotify.Chmod) != 0 {
		state, err := s.read()
		s.cached = state
		s.cachedErr = err
		s.cacheValid = true
	}
	s.mu.Unlock()
	if closeWatcher != nil {
		_ = closeWatcher.watcher.Close()
		s.restartWatcher()
	}
}

func (s *Service) failWatcher(watcher *watcherState) {
	s.mu.Lock()
	if s.watcher != watcher {
		s.mu.Unlock()
		return
	}
	s.watcher = nil
	s.invalidateLocked()
	s.mu.Unlock()
	_ = watcher.watcher.Close()
	s.restartWatcher()
}

func (s *Service) restartWatcher() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed && s.watcher == nil {
		s.startWatcherLocked()
	}
}

func (s *Service) invalidateLocked() {
	s.cached = State{}
	s.cachedErr = nil
	s.cacheValid = false
}

func (s *Service) reconcileWatcherLocked(watcher *watcherState, rebuild bool) bool {
	directories, targets, parents := s.watchPaths()
	watchList := watcher.watcher.WatchList()
	if rebuild {
		watcher.directories = make(map[string]struct{})
	} else if watchList != nil {
		watcher.directories = make(map[string]struct{}, len(watchList))
		for _, directory := range watchList {
			directory = filepath.Clean(directory)
			if info, err := os.Stat(directory); err == nil && info.IsDir() {
				watcher.directories[directory] = struct{}{}
			}
		}
	} else {
		for directory := range watcher.directories {
			if info, err := os.Stat(directory); err != nil || !info.IsDir() {
				delete(watcher.directories, directory)
			}
		}
	}
	for directory := range watcher.directories {
		if _, ok := directories[directory]; ok {
			continue
		}
		_ = watcher.watcher.Remove(directory)
		delete(watcher.directories, directory)
	}
	for directory := range directories {
		if _, ok := watcher.directories[directory]; ok {
			continue
		}
		if err := watcher.watcher.Add(directory); err == nil {
			watcher.directories[directory] = struct{}{}
		}
	}
	watcher.targets = targets
	watcher.parents = parents
	return len(watcher.directories) > 0
}

func (s *Service) watchPaths() (map[string]struct{}, map[string]struct{}, map[string]struct{}) {
	directories := make(map[string]struct{})
	targets := make(map[string]struct{})
	parents := make(map[string]struct{})

	addDirectory := func(path string) {
		for {
			path = filepath.Clean(path)
			directories[path] = struct{}{}
			parents[path] = struct{}{}
			parent := filepath.Dir(path)
			if parent == path {
				return
			}
			path = parent
		}
	}
	addTarget := func(path string) {
		path = filepath.Clean(path)
		targets[path] = struct{}{}
		addDirectory(filepath.Dir(path))
	}

	addTarget(s.path)
	if resolved, err := filepath.EvalSymlinks(s.path); err == nil {
		addTarget(resolved)
	} else if link, err := os.Readlink(s.path); err == nil {
		base, baseErr := filepath.EvalSymlinks(filepath.Dir(s.path))
		if baseErr != nil {
			base = filepath.Dir(s.path)
		}
		if !filepath.IsAbs(link) {
			link = filepath.Join(base, link)
		}
		addTarget(link)
	}
	return directories, targets, parents
}

func pathWithin(path, ancestor string) bool {
	relative, err := filepath.Rel(ancestor, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
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
