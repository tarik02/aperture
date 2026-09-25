package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The restore worker is a Node program (apps/restore-worker) that validates
// SessionInitialization capsules and restores them into a running browser.
const (
	restoreWorkerName     = "aperture-browser-restore"
	restoreWorkerTimeout  = 10 * time.Minute
	validateWorkerTimeout = time.Minute
)

// ErrInvalidSessionInitialization marks browser state that the restore worker rejected.
var ErrInvalidSessionInitialization = errors.New("invalid browser initialization")

// ValidateSessionInitialization checks an encoded SessionInitialization before a
// browser is started for it.
func ValidateSessionInitialization(ctx context.Context, capsule []byte) error {
	worker, err := restoreWorkerPath()
	if err != nil {
		return err
	}
	path, remove, err := writeCapsuleFile(capsule)
	if err != nil {
		return err
	}
	defer remove()

	ctx, cancel := context.WithTimeout(ctx, validateWorkerTimeout)
	defer cancel()
	var stderr bytes.Buffer
	command := exec.CommandContext(ctx, worker, "validate", path)
	command.Stderr = &stderr
	return restoreWorkerError(ctx, &stderr, command.Run())
}

type restoreWorkerResult struct {
	TargetIDs             []string                     `json:"targetIds"`
	ActiveIndex           int                          `json:"activeIndex"`
	SessionStorageSources map[string]map[string]string `json:"sessionStorageSources"`
}

// runRestoreWorker restores the capsule into the browser at cdpPort.
//
// Session storage preload scripts the worker registered for origins that have
// not loaded yet die with its CDP connection, so the worker reports them and
// keeps running until Go has registered them on its own connection. Closing the
// worker's stdin tells it to exit.
func runRestoreWorker(ctx context.Context, cdpPort int, capsule []byte, browser *liveSessionBrowser) (restoreWorkerResult, error) {
	worker, err := restoreWorkerPath()
	if err != nil {
		return restoreWorkerResult{}, err
	}
	path, remove, err := writeCapsuleFile(capsule)
	if err != nil {
		return restoreWorkerResult{}, err
	}
	defer remove()

	ctx, cancel := context.WithTimeout(ctx, restoreWorkerTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, worker, "restore", fmt.Sprintf("http://127.0.0.1:%d", cdpPort), path)
	handoff, err := command.StdinPipe()
	if err != nil {
		return restoreWorkerResult{}, fmt.Errorf("open browser restore worker input: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return restoreWorkerResult{}, fmt.Errorf("open browser restore worker output: %w", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	command.WaitDelay = 5 * time.Second
	if err := command.Start(); err != nil {
		return restoreWorkerResult{}, fmt.Errorf("start browser restore worker: %w", err)
	}

	reader := bufio.NewReader(stdout)
	// finish lets the worker exit and waits for it; kill aborts a worker that may still be restoring.
	finish := func(kill bool) error {
		_ = handoff.Close()
		if kill {
			_ = command.Process.Kill()
		}
		_, _ = io.Copy(io.Discard, reader)
		return command.Wait()
	}

	line, err := reader.ReadBytes('\n')
	if errors.Is(err, io.EOF) {
		if err := restoreWorkerError(ctx, &stderr, finish(false)); err != nil {
			return restoreWorkerResult{}, err
		}
		return restoreWorkerResult{}, errors.New("browser restore worker exited without a result")
	}
	if err != nil {
		return restoreWorkerResult{}, errors.Join(err, finish(true))
	}

	var result restoreWorkerResult
	if err := json.Unmarshal(line, &result); err != nil {
		_ = finish(true)
		return restoreWorkerResult{}, errors.New("browser restore worker returned an invalid result")
	}
	for targetID, sources := range result.SessionStorageSources {
		if err := browser.installInitialSessionStorageScripts(ctx, targetID, sources); err != nil {
			_ = finish(true)
			return restoreWorkerResult{}, err
		}
	}

	_ = handoff.Close()
	extraBytes, readErr := io.Copy(io.Discard, reader)
	if err := restoreWorkerError(ctx, &stderr, command.Wait()); err != nil {
		return restoreWorkerResult{}, err
	}
	if readErr != nil || extraBytes != 0 {
		return restoreWorkerResult{}, errors.New("browser restore worker returned unexpected output")
	}
	return result, nil
}

// restoreWorkerPath finds the worker next to the running binary, where the Nix
// package installs every Aperture binary, and falls back to PATH.
func restoreWorkerPath() (string, error) {
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), restoreWorkerName)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	path, err := exec.LookPath(restoreWorkerName)
	if err != nil {
		return "", fmt.Errorf("locate %s: %w", restoreWorkerName, err)
	}
	return path, nil
}

// writeCapsuleFile stores the capsule in a private temporary file for the worker.
func writeCapsuleFile(capsule []byte) (string, func(), error) {
	file, err := os.CreateTemp("", "aperture-browser-state-*.json")
	if err != nil {
		return "", nil, fmt.Errorf("create browser state file: %w", err)
	}
	remove := func() { _ = os.Remove(file.Name()) }
	_, writeErr := file.Write(capsule)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		remove()
		return "", nil, fmt.Errorf("write browser state file: %w", err)
	}
	return file.Name(), remove, nil
}

// restoreWorkerError converts the worker's exit status into an error. Exit code 2
// means the capsule is invalid and stderr names the offending field; any other
// failure's diagnostic is logged locally.
func restoreWorkerError(ctx context.Context, stderr *bytes.Buffer, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: restore worker stopped: %v\n", ctx.Err())
		return fmt.Errorf("browser restore worker stopped: %w", ctx.Err())
	}
	message := strings.TrimSpace(stderr.String())
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 2 {
		return fmt.Errorf("%w: %s", ErrInvalidSessionInitialization, message)
	}
	// Any other diagnostic stays in the local log: the API error remains generic.
	if message != "" {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: restore worker failed: %s\n", message)
	} else {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: restore worker failed: %v\n", err)
	}
	return errors.New("browser restore worker failed")
}
