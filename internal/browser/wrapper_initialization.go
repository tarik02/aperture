package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const wrapperInitializationBodyLimit = 64 * 1024 * 1024

const localStorageImportTimeout = time.Minute

func (r *wrapperRuntime) handleInitialization(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}

	body, err := io.ReadAll(io.LimitReader(req.Body, wrapperInitializationBodyLimit+1))
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, "read browser initialization")
		return
	}
	if len(body) > wrapperInitializationBodyLimit {
		writeWrapperError(w, http.StatusRequestEntityTooLarge, "browser initialization exceeds 64 MiB")
		return
	}
	var input SessionInitialization
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid browser initialization")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeWrapperError(w, http.StatusBadRequest, "invalid browser initialization")
		return
	}
	if err := input.Validate(); err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
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
	if err := live.browser.initialize(req.Context(), input); err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	live.reconcileAndBroadcastTargetsLocked()
	w.WriteHeader(http.StatusNoContent)
}

func (browser *liveSessionBrowser) initialize(ctx context.Context, input SessionInitialization) error {
	if err := browser.waitUntilStartupTargetReady(ctx); err != nil {
		return fmt.Errorf("wait for startup browser target: %w", err)
	}
	if input.StorageState != nil {
		if err := browser.restoreCookies(input.StorageState.Cookies); err != nil {
			return fmt.Errorf("restore cookies: %w", err)
		}
		for _, origin := range input.StorageState.Origins {
			if err := browser.restoreLocalStorage(ctx, origin); err != nil {
				return fmt.Errorf("restore local storage for %s: %w", origin.Origin, err)
			}
		}
	}
	if len(input.Targets) == 0 {
		return nil
	}

	existing, err := browser.targets()
	if err != nil {
		return fmt.Errorf("list existing browser targets: %w", err)
	}
	for _, target := range input.Targets {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := browser.createTarget(target.URL); err != nil {
			return fmt.Errorf("create initial browser target: %w", err)
		}
	}
	for _, target := range existing {
		if err := browser.closeTarget(target.ID); err != nil {
			return fmt.Errorf("close replaced browser target: %w", err)
		}
	}
	return nil
}

func (browser *liveSessionBrowser) restoreCookies(cookies []InitialCookie) error {
	if len(cookies) == 0 {
		return nil
	}
	return browser.call("Storage.setCookies", map[string]any{"cookies": cookies}, "", nil)
}

func (browser *liveSessionBrowser) restoreLocalStorage(ctx context.Context, origin InitialStorageOrigin) error {
	canonicalOrigin, err := canonicalHTTPOrigin(origin.Origin)
	if err != nil {
		return err
	}
	targetID, err := browser.createTarget("about:blank")
	if err != nil {
		return err
	}
	defer func() { _ = browser.closeTarget(targetID) }()

	entries, err := json.Marshal(origin.LocalStorage)
	if err != nil {
		return err
	}
	source := fmt.Sprintf(`(() => {
  try {
    for (const entry of %s) localStorage.setItem(entry.name, entry.value);
    return { status: "succeeded" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  }
})()`, entries)

	return browser.withTarget(targetID, func(sessionID string) error {
		var navigation struct {
			ErrorText string `json:"errorText"`
		}
		if err := browser.call("Page.navigate", map[string]any{"url": canonicalOrigin}, sessionID, &navigation); err != nil {
			return err
		}
		if navigation.ErrorText != "" {
			return fmt.Errorf("navigate to origin: %s", navigation.ErrorText)
		}

		deadline := time.Now().Add(localStorageImportTimeout)
		originReady := false
		for time.Now().Before(deadline) {
			if err := ctx.Err(); err != nil {
				return err
			}
			var evaluation struct {
				Result struct {
					Value string `json:"value"`
				} `json:"result"`
				ExceptionDetails *json.RawMessage `json:"exceptionDetails"`
			}
			err := browser.call("Runtime.evaluate", map[string]any{
				"expression":    "location.origin",
				"returnByValue": true,
			}, sessionID, &evaluation)
			if err == nil && evaluation.ExceptionDetails == nil && evaluation.Result.Value == canonicalOrigin {
				originReady = true
				break
			}
			timer := time.NewTimer(25 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		if !originReady {
			return errors.New("browser did not navigate to the local storage origin within 1 minute")
		}
		if err := browser.call("Page.stopLoading", map[string]any{}, sessionID, nil); err != nil {
			return err
		}

		var evaluation struct {
			Result struct {
				Value *struct {
					Status string `json:"status"`
					Error  string `json:"error"`
				} `json:"value"`
			} `json:"result"`
			ExceptionDetails *json.RawMessage `json:"exceptionDetails"`
		}
		if err := browser.call("Runtime.evaluate", map[string]any{
			"expression":    source,
			"returnByValue": true,
		}, sessionID, &evaluation); err != nil {
			return err
		}
		if evaluation.ExceptionDetails != nil || evaluation.Result.Value == nil {
			return errors.New("browser could not evaluate the local storage import")
		}
		if evaluation.Result.Value.Status == "failed" {
			return fmt.Errorf("browser rejected local storage: %s", evaluation.Result.Value.Error)
		}
		if evaluation.Result.Value.Status != "succeeded" {
			return errors.New("browser returned an invalid local storage import result")
		}
		return nil
	})
}
