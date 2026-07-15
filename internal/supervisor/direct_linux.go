//go:build linux

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/paths"
	"golang.org/x/sys/unix"
)

const directStopTimeout = 20 * time.Second

type directBackend struct {
	cfg       config.Config
	shell     string
	wrapper   string
	mu        sync.Mutex
	processes map[string]*directProcess
}

type directProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func newDirectBackend(cfg config.Config) (browserBackend, error) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		return nil, fmt.Errorf("locate shell: %w", err)
	}
	wrapper, err := exec.LookPath("browser-session-wrapper")
	if err != nil {
		return nil, fmt.Errorf("locate browser-session-wrapper: %w", err)
	}
	return &directBackend{cfg: cfg, shell: shell, wrapper: wrapper, processes: make(map[string]*directProcess)}, nil
}

func (b *directBackend) Start(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	layout, err := paths.Session(b.cfg, sessionID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(layout.RuntimeEnv); err != nil {
		return fmt.Errorf("stat browser runtime env: %w", err)
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.processes[sessionID] != nil {
		return nil
	}

	cmd := exec.Command(b.shell, "-c", `set -a; . "$1"; exec "$2"`, "aperture-direct-browser", layout.RuntimeEnv, b.wrapper)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
	if err := cmd.Start(); err != nil {
		return err
	}

	process := &directProcess{cmd: cmd, done: make(chan struct{})}
	b.processes[sessionID] = process
	go func() {
		_ = cmd.Wait()
		b.mu.Lock()
		if b.processes[sessionID] == process {
			delete(b.processes, sessionID)
		}
		close(process.done)
		b.mu.Unlock()
	}()
	return nil
}

func (b *directBackend) Stop(ctx context.Context, sessionID string) error {
	b.mu.Lock()
	process := b.processes[sessionID]
	b.mu.Unlock()
	if process == nil {
		return nil
	}

	if err := signalDirectProcess(process, unix.SIGTERM); err != nil {
		return err
	}
	timer := time.NewTimer(directStopTimeout)
	defer timer.Stop()
	select {
	case <-process.done:
		return nil
	case <-ctx.Done():
		_ = signalDirectProcess(process, unix.SIGKILL)
		return ctx.Err()
	case <-timer.C:
		if err := signalDirectProcess(process, unix.SIGKILL); err != nil {
			return err
		}
		<-process.done
		return nil
	}
}

func (b *directBackend) IsActive(ctx context.Context, sessionID string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.processes[sessionID] != nil, nil
}

func (b *directBackend) ListActiveSessionIDs(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b.mu.Lock()
	ids := make([]string, 0, len(b.processes))
	for sessionID := range b.processes {
		ids = append(ids, sessionID)
	}
	b.mu.Unlock()
	sort.Strings(ids)
	return ids, nil
}

func (b *directBackend) Close(ctx context.Context) error {
	b.mu.Lock()
	ids := make([]string, 0, len(b.processes))
	for sessionID := range b.processes {
		ids = append(ids, sessionID)
	}
	b.mu.Unlock()
	sort.Strings(ids)

	errCh := make(chan error, len(ids))
	var wg sync.WaitGroup
	for _, sessionID := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := b.Stop(ctx, sessionID); err != nil {
				errCh <- fmt.Errorf("stop session %s: %w", sessionID, err)
			}
		}()
	}
	wg.Wait()
	close(errCh)

	var errs []error
	for err := range errCh {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func signalDirectProcess(process *directProcess, signal unix.Signal) error {
	if process == nil || process.cmd.Process == nil {
		return nil
	}
	err := unix.Kill(-process.cmd.Process.Pid, signal)
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	return err
}
