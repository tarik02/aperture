package browser

import (
	"errors"
	"io"
	"net/http"
)

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
	result, err := runRestoreWorker(req.Context(), r.values.CDPPort, body, live.browser)
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
