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
	"strings"
	"time"
)

const MaxStorageExportRequestBytes = 256 * 1024

// storageExportRejection is a worker refusal of the selection or of the selected
// storage. Its message is meant for the API caller.
type storageExportRejection struct {
	status  int
	message string
}

func (e *storageExportRejection) Error() string { return e.message }

// runStorageExport runs the browser worker, bounding both runtime and output.
func runStorageExport(ctx context.Context, cdpPort int, selection []byte) ([]byte, error) {
	worker, err := restoreWorkerPath()
	if err != nil {
		return nil, err
	}
	path, remove, err := writeCapsuleFile(selection)
	if err != nil {
		return nil, err
	}
	defer remove()
	ctx, cancel := context.WithTimeout(ctx, restoreWorkerTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, worker, "export", fmt.Sprintf("http://127.0.0.1:%d", cdpPort), path)
	// Give scoped browser cleanup time to close helper pages on cancellation.
	command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
	command.WaitDelay = 10 * time.Second
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(stdout, MaxSessionInitializationBytes+1))
	if err == nil && len(body) > MaxSessionInitializationBytes {
		err = errors.New("storage export exceeds 64 MiB")
	}
	if err != nil {
		cancel()
		_ = command.Wait()
		return nil, fmt.Errorf("read storage export: %w", err)
	}
	waitErr := command.Wait()
	var exit *exec.ExitError
	if ctx.Err() == nil && errors.As(waitErr, &exit) {
		message := strings.TrimSpace(stderr.String())
		switch exit.ExitCode() {
		case 2:
			return nil, &storageExportRejection{status: http.StatusBadRequest, message: message}
		case 3:
			return nil, &storageExportRejection{status: http.StatusUnprocessableEntity, message: message}
		}
	}
	if err := restoreWorkerError(ctx, &stderr, waitErr); err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, errors.New("storage export returned invalid JSON")
	}
	return body, nil
}

func (r *wrapperRuntime) handleStorageExport(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, MaxStorageExportRequestBytes+1))
	if err != nil || len(body) > MaxStorageExportRequestBytes {
		writeWrapperError(w, http.StatusBadRequest, "invalid storage export request")
		return
	}
	// Export helper targets must not race another export or initialization.
	r.storageExportMu.Lock()
	defer r.storageExportMu.Unlock()
	if err := req.Context().Err(); err != nil {
		return
	}
	result, err := runStorageExport(req.Context(), r.values.CDPPort, body)
	var rejection *storageExportRejection
	if errors.As(err, &rejection) {
		writeWrapperError(w, rejection.status, rejection.message)
		return
	}
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(result)
}
