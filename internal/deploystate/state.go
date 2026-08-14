package deploystate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/google/renameio/v2"
	"golang.org/x/sys/unix"
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

// FileLock serializes deployment promotion with route publication across processes.
type FileLock struct {
	file      *os.File
	inherited bool
	path      string
}

type lockContextKey struct{}

// WithLock runs fn while holding the deployment lock and propagates ownership to nested writers.
func WithLock(ctx context.Context, statePath string, fn func(context.Context) error) error {
	lock, err := AcquireLock(ctx, statePath)
	if err != nil {
		return err
	}
	resultErr := fn(context.WithValue(ctx, lockContextKey{}, lock))
	if closeErr := lock.Close(); closeErr != nil {
		return errors.Join(resultErr, closeErr)
	}
	return resultErr
}

// AcquireLock takes the deployment lock associated with statePath.
func AcquireLock(ctx context.Context, statePath string) (*FileLock, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if lock, ok := ctx.Value(lockContextKey{}).(*FileLock); ok && lock.path == statePath {
		if lock.file == nil || !lockMatchesCurrentAnchor(lock.file, statePath) {
			return nil, errors.New("deployment lock pathname was replaced while held")
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return &FileLock{inherited: true, path: statePath}, nil
	}
	if fdText := os.Getenv("APERTURE_DEPLOY_LOCK_FD"); fdText != "" {
		fd, parseErr := strconv.Atoi(fdText)
		if parseErr != nil || fd < 0 {
			return nil, errors.New("invalid inherited deployment lock descriptor")
		}
		lockPath := statePath + ".lock.anchor"
		fdPath, fdErr := os.Stat(fmt.Sprintf("/proc/self/fd/%d", fd))
		lockTarget, targetErr := os.Stat(lockPath)
		_, descriptorErr := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		if fdErr != nil || targetErr != nil || descriptorErr != nil || !os.SameFile(fdPath, lockTarget) {
			return nil, errors.New("inherited deployment lock descriptor does not match current lock inode")
		}
		if !inheritedLockHeld(fd) {
			return nil, errors.New("inherited deployment lock descriptor is not locked")
		}
		return &FileLock{inherited: true, path: statePath}, nil
	}
	lockPath := statePath + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, fmt.Errorf("mkdir deployment lock dir: %w", err)
	}
	anchorPath := lockPath + ".anchor"
	if err := ensureLockAnchor(lockPath, anchorPath); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(anchorPath, os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open deployment lock: %w", err)
	}
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			if !lockMatchesCurrentAnchor(file, statePath) {
				_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
				_ = file.Close()
				return nil, errors.New("deployment lock pathname was replaced during acquisition")
			}
			return &FileLock{file: file, path: statePath}, nil
		}
		if err != unix.EAGAIN && err != unix.EWOULDBLOCK {
			_ = file.Close()
			return nil, fmt.Errorf("lock deployment state: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// ensureLockAnchor keeps a second hard link to the lock inode. Writers lock the
// anchor, so renaming or replacing the public pathname cannot split the lock.
func ensureLockAnchor(lockPath, anchorPath string) error {
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		if _, anchorErr := os.Stat(anchorPath); anchorErr == nil {
			if linkErr := os.Link(anchorPath, lockPath); linkErr != nil && !os.IsExist(linkErr) {
				return fmt.Errorf("restore deployment lock pathname: %w", linkErr)
			}
		} else if !os.IsNotExist(anchorErr) {
			return fmt.Errorf("stat deployment lock anchor: %w", anchorErr)
		}
	}
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		file, createErr := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
		if createErr != nil {
			return fmt.Errorf("open deployment lock: %w", createErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return fmt.Errorf("close deployment lock: %w", closeErr)
		}
	} else if err != nil {
		return fmt.Errorf("stat deployment lock: %w", err)
	}
	lockInfo, err := os.Stat(lockPath)
	if err != nil {
		return fmt.Errorf("stat deployment lock: %w", err)
	}
	anchorInfo, anchorErr := os.Stat(anchorPath)
	if anchorErr == nil {
		if !os.SameFile(lockInfo, anchorInfo) {
			return errors.New("deployment lock pathname was replaced; lock anchor inode differs")
		}
		return nil
	}
	if !os.IsNotExist(anchorErr) {
		return fmt.Errorf("stat deployment lock anchor: %w", anchorErr)
	}
	if err := os.Link(lockPath, anchorPath); err != nil && !os.IsExist(err) {
		return fmt.Errorf("create deployment lock anchor: %w", err)
	}
	anchorInfo, err = os.Stat(anchorPath)
	if err != nil || !os.SameFile(lockInfo, anchorInfo) {
		return errors.New("deployment lock anchor inode differs from lock pathname")
	}
	return nil
}

// inheritedLockHeld verifies the supplied descriptor itself owns the lock. A
// nonblocking flock on an inherited open file description succeeds, while a
// separately opened descriptor for the same pathname contends and fails.
func inheritedLockHeld(fd int) bool {
	if !lockEntryPresent(fd) {
		return false
	}
	if unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB) != nil {
		return false
	}
	return lockEntryPresent(fd)
}

func lockEntryPresent(fd int) bool {
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil {
		return false
	}
	locks, err := os.ReadFile("/proc/locks")
	if err != nil {
		return false
	}
	device := fmt.Sprintf("%02x:%02x", unix.Major(uint64(stat.Dev)), unix.Minor(uint64(stat.Dev)))
	inode := strconv.FormatUint(stat.Ino, 10)
	for _, line := range strings.Split(string(locks), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || fields[1] != "FLOCK" || fields[3] != "WRITE" {
			continue
		}
		parts := strings.Split(fields[5], ":")
		if len(parts) == 3 && parts[0]+":"+parts[1] == device && parts[2] == inode {
			return true
		}
	}
	return false
}

func lockMatchesCurrentAnchor(file *os.File, statePath string) bool {
	fdInfo, err := file.Stat()
	if err != nil {
		return false
	}
	pathInfo, err := os.Stat(statePath + ".lock.anchor")
	return err == nil && os.SameFile(fdInfo, pathInfo)
}

// Close releases the deployment lock.
func (l *FileLock) Close() error {
	if l.inherited {
		return nil
	}
	if err := unix.Flock(int(l.file.Fd()), unix.LOCK_UN); err != nil {
		return errors.Join(fmt.Errorf("unlock deployment state: %w", err), l.file.Close())
	}
	return l.file.Close()
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
	return s.EnsureActiveContext(context.Background(), color, version)
}

// EnsureActiveContext initializes deployment state while honoring cancellation.
func (s *Service) EnsureActiveContext(ctx context.Context, color, version string) (state State, resultErr error) {
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	lock, err := AcquireLock(ctx, s.path)
	if err != nil {
		return State{}, err
	}
	defer func() {
		if closeErr := lock.Close(); closeErr != nil {
			resultErr = errors.Join(resultErr, closeErr)
		}
	}()
	if err := ctx.Err(); err != nil {
		return State{}, err
	}

	state, err = s.Load()
	if checkErr := ctx.Err(); checkErr != nil {
		return State{}, checkErr
	}
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return State{}, err
	}
	return s.MarkActiveContext(context.WithValue(ctx, lockContextKey{}, lock), color, version)
}

// MarkActive atomically records color as the active API color.
func (s *Service) MarkActive(color, version string) (State, error) {
	return s.MarkActiveContext(context.Background(), color, version)
}

// MarkActiveContext records color as active while honoring cancellation while waiting.
func (s *Service) MarkActiveContext(ctx context.Context, color, version string) (state State, resultErr error) {
	lock, err := AcquireLock(ctx, s.path)
	if err != nil {
		return State{}, err
	}
	defer func() {
		if closeErr := lock.Close(); closeErr != nil {
			resultErr = errors.Join(resultErr, closeErr)
		}
	}()
	if err := ctx.Err(); err != nil {
		return State{}, err
	}

	color = strings.ToLower(strings.TrimSpace(color))
	if !IsColor(color) {
		return State{}, fmt.Errorf("deployment color must be blue or green")
	}

	state = State{
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
	if err := ctx.Err(); err != nil {
		return State{}, err
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return State{}, fmt.Errorf("mkdir deployment state dir: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return State{}, err
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
