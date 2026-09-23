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
	result, err := r.runRestoreWorker(req.Context(), body, func(ctx context.Context, result restoreWorkerResult) error {
		for targetID, sources := range result.SessionStorageSources {
			if err := live.browser.installInitialSessionStorageScripts(ctx, targetID, sources); err != nil {
				return err
			}
		}
		return nil
	})
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

func (r *wrapperRuntime) runRestoreWorker(
	parent context.Context,
	capsule []byte,
	beforeDisconnect func(context.Context, restoreWorkerResult) error,
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
	stderr := &boundedOutput{limit: 64 * 1024}
	command.Stderr = stderr
	command.WaitDelay = 5 * time.Second
	if err := command.Start(); err != nil {
		return restoreWorkerResult{}, fmt.Errorf("start browser restore worker: %w", err)
	}
	reader := bufio.NewReader(stdout)
	stop := func() error {
		_ = stdin.Close()
		_ = command.Process.Kill()
		_, _ = io.Copy(io.Discard, reader)
		return command.Wait()
	}
	finishAfterInputError := func(writeErr error) error {
		_ = stdin.Close()
		_, _ = io.Copy(io.Discard, reader)
		return restoreWorkerFailure(ctx, stderr, errors.Join(writeErr, command.Wait()))
	}

	if _, err := stdin.Write(capsule); err != nil {
		return restoreWorkerResult{}, finishAfterInputError(err)
	}
	if _, err := stdin.Write([]byte{'\n'}); err != nil {
		return restoreWorkerResult{}, finishAfterInputError(err)
	}

	line, err := readRestoreWorkerLine(reader)
	if err != nil {
		_ = stdin.Close()
		if errors.Is(err, io.EOF) {
			return restoreWorkerResult{}, restoreWorkerFailure(ctx, stderr, command.Wait())
		}
		return restoreWorkerResult{}, errors.Join(err, stop())
	}

	var result restoreWorkerResult
	if err := json.Unmarshal(line, &result); err != nil {
		_ = stop()
		return restoreWorkerResult{}, errors.New("browser restore worker returned an invalid result")
	}
	if err := beforeDisconnect(ctx, result); err != nil {
		_ = stop()
		return restoreWorkerResult{}, err
	}
	if _, err := stdin.Write([]byte("ready\n")); err != nil {
		return restoreWorkerResult{}, restoreWorkerFailure(ctx, stderr, errors.Join(err, stop()))
	}
	_ = stdin.Close()
	extra := &boundedOutput{limit: 128 * 1024 * 1024}
	_, readErr := io.Copy(extra, reader)
	if err := command.Wait(); err != nil {
		return restoreWorkerResult{}, restoreWorkerFailure(ctx, stderr, err)
	}
	if extra.truncated || stderr.truncated {
		return restoreWorkerResult{}, errors.New("browser restore worker output exceeded its limit")
	}
	if readErr != nil || extra.Len() != 0 {
		return restoreWorkerResult{}, errors.New("browser restore worker returned unexpected output")
	}
	return result, nil
}

func readRestoreWorkerLine(reader *bufio.Reader) ([]byte, error) {
	output := &boundedOutput{limit: 128 * 1024 * 1024}
	for {
		part, err := reader.ReadSlice('\n')
		_, _ = output.Write(part)
		if output.truncated {
			return nil, errors.New("browser restore worker output exceeded its limit")
		}
		if err == nil {
			return bytes.TrimSuffix(output.Bytes(), []byte{'\n'}), nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

func restoreWorkerFailure(ctx context.Context, stderr *boundedOutput, err error) error {
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
