package browser

import (
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
	result, err := r.runRestoreWorker(req.Context(), body)
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	live.browser.setInitialTargetOrder(result.TargetIDs, result.ActiveIndex)
	for targetID, sources := range result.SessionStorageSources {
		if err := live.browser.installInitialSessionStorageScripts(req.Context(), targetID, sources); err != nil {
			writeWrapperError(w, http.StatusBadGateway, err.Error())
			return
		}
	}
	live.reconcileAndBroadcastTargetsLocked()
	w.WriteHeader(http.StatusNoContent)
}

type restoreWorkerResult struct {
	TargetIDs             []string                     `json:"targetIds"`
	ActiveIndex           int                          `json:"activeIndex"`
	SessionStorageSources map[string]map[string]string `json:"sessionStorageSources"`
}

type boundedOutput struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (output *boundedOutput) Write(data []byte) (int, error) {
	n := len(data)
	remaining := output.limit - output.Len()
	if remaining < n {
		output.truncated = true
		if remaining > 0 {
			_, _ = output.Buffer.Write(data[:remaining])
		}
		return n, nil
	}
	_, _ = output.Buffer.Write(data)
	return n, nil
}

func (r *wrapperRuntime) runRestoreWorker(parent context.Context, capsule []byte) (restoreWorkerResult, error) {
	executable, err := os.Executable()
	if err != nil {
		return restoreWorkerResult{}, fmt.Errorf("find browser wrapper executable: %w", err)
	}
	worker := filepath.Join(filepath.Dir(executable), "aperture-browser-restore")
	ctx, cancel := context.WithTimeout(parent, browserStateImportTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, worker, fmt.Sprintf("http://127.0.0.1:%d", r.values.CDPPort))
	command.Stdin = bytes.NewReader(capsule)
	stdout := &boundedOutput{limit: 128 * 1024 * 1024}
	stderr := &boundedOutput{limit: 64 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	command.WaitDelay = 5 * time.Second
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return restoreWorkerResult{}, fmt.Errorf("browser restore worker stopped: %w", ctx.Err())
		}
		message := bytes.TrimSpace(stderr.Bytes())
		if len(message) != 0 {
			return restoreWorkerResult{}, fmt.Errorf("browser restore worker failed: %s", message)
		}
		return restoreWorkerResult{}, fmt.Errorf("browser restore worker failed: %w", err)
	}
	if stdout.truncated || stderr.truncated {
		return restoreWorkerResult{}, errors.New("browser restore worker output exceeded its limit")
	}
	var result restoreWorkerResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return restoreWorkerResult{}, errors.New("browser restore worker returned an invalid result")
	}
	return result, nil
}
