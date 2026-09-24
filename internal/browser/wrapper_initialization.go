package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const browserStateImportTimeout = 10 * time.Minute

var ErrInvalidSessionInitialization = errors.New("invalid browser initialization")

func (r *wrapperRuntime) handleInitialization(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}

	body, err := io.ReadAll(io.LimitReader(req.Body, MaxSessionInitializationBytes+1))
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, "read browser initialization")
		return
	}
	if len(body) > MaxSessionInitializationBytes {
		writeWrapperError(w, http.StatusRequestEntityTooLarge, "browser initialization exceeds 64 MiB")
		return
	}

	r.mu.Lock()
	live := r.liveSession
	r.mu.Unlock()
	if live == nil {
		writeWrapperError(w, http.StatusServiceUnavailable, "live session is not running")
		return
	}

	unlock := live.lockTargetChanges()
	defer unlock()
	if err := live.browser.waitUntilStartupTargetReady(req.Context()); err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	result, err := r.runRestoreWorker(req.Context(), body, live.browser)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, ErrInvalidSessionInitialization) {
			status = http.StatusBadRequest
		}
		writeWrapperError(w, status, err.Error())
		return
	}
	live.browser.setInitialTargetOrder(result.TargetIDs, result.ActiveIndex)
	live.reconcileAndBroadcastTargetsLocked()
	w.WriteHeader(http.StatusNoContent)
}

type restoreWorkerResult struct {
	TargetIDs             []string                     `json:"targetIds"`
	ActiveIndex           int                          `json:"activeIndex"`
	SessionStorageSources map[string]map[string]string `json:"sessionStorageSources"`
}

func (r *wrapperRuntime) runRestoreWorker(
	parent context.Context,
	capsule []byte,
	browser *liveSessionBrowser,
) (restoreWorkerResult, error) {
	executable, err := os.Executable()
	if err != nil {
		return restoreWorkerResult{}, fmt.Errorf("find browser wrapper executable: %w", err)
	}
	worker := filepath.Join(filepath.Dir(executable), "aperture-browser-restore")
	ctx, cancel := context.WithTimeout(parent, browserStateImportTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, worker, fmt.Sprintf("http://127.0.0.1:%d", r.values.CDPPort))
	stdin, err := command.StdinPipe()
	if err != nil {
		return restoreWorkerResult{}, fmt.Errorf("open browser restore worker input: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return restoreWorkerResult{}, fmt.Errorf("open browser restore worker output: %w", err)
	}
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	command.WaitDelay = 5 * time.Second
	if err := command.Start(); err != nil {
		return restoreWorkerResult{}, fmt.Errorf("start browser restore worker: %w", err)
	}
	reader := bufio.NewReader(stdout)
	// finish closes the worker input and waits for the worker to exit. kill aborts
	// a worker that may still be restoring.
	finish := func(kill bool) error {
		_ = stdin.Close()
		if kill {
			_ = command.Process.Kill()
		}
		_, _ = io.Copy(io.Discard, reader)
		return command.Wait()
	}

	// The capsule and the worker's result are each a single JSON line. Closing
	// stdin afterwards tells the worker that Go has taken over its preload scripts.
	_, err = stdin.Write(capsule)
	if err == nil {
		_, err = stdin.Write([]byte{'\n'})
	}
	if err != nil {
		return restoreWorkerResult{}, restoreWorkerFailure(ctx, stderr, errors.Join(err, finish(false)))
	}

	line, err := reader.ReadBytes('\n')
	if errors.Is(err, io.EOF) {
		return restoreWorkerResult{}, restoreWorkerFailure(ctx, stderr, finish(false))
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

	_ = stdin.Close()
	extraBytes, readErr := io.Copy(io.Discard, reader)
	if err := command.Wait(); err != nil {
		return restoreWorkerResult{}, restoreWorkerFailure(ctx, stderr, err)
	}
	if readErr != nil || extraBytes != 0 {
		return restoreWorkerResult{}, errors.New("browser restore worker returned unexpected output")
	}
	return result, nil
}

func restoreWorkerFailure(ctx context.Context, stderr *bytes.Buffer, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("browser restore worker stopped: %w", ctx.Err())
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 2 {
		return ErrInvalidSessionInitialization
	}
	message := bytes.TrimSpace(stderr.Bytes())
	if len(message) != 0 {
		return fmt.Errorf("browser restore worker failed: %s", message)
	}
	if err == nil {
		return errors.New("browser restore worker returned no result")
	}
	return fmt.Errorf("browser restore worker failed: %w", err)
}
