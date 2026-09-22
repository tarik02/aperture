package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/storage"
	"github.com/chromedp/cdproto/target"
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
	params := make([]*network.CookieParam, 0, len(cookies))
	for _, cookie := range cookies {
		param := &network.CookieParam{
			Name:     cookie.Name,
			Value:    cookie.Value,
			Domain:   cookie.Domain,
			Path:     cookie.Path,
			Secure:   cookie.Secure,
			HTTPOnly: cookie.HTTPOnly,
			SameSite: network.CookieSameSite(cookie.SameSite),
		}
		if cookie.Expires != nil {
			seconds, fraction := math.Modf(*cookie.Expires)
			expires := cdp.TimeSinceEpoch(time.Unix(int64(seconds), int64(fraction*float64(time.Second))).UTC())
			param.Expires = &expires
		}
		params = append(params, param)
	}
	return browser.execute("", func(ctx context.Context) error {
		return storage.SetCookies(params).Do(ctx)
	})
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

	var sessionID target.SessionID
	if err := browser.execute("", func(ctx context.Context) error {
		var err error
		sessionID, err = target.AttachToTarget(target.ID(targetID)).WithFlatten(true).Do(ctx)
		return err
	}); err != nil {
		return err
	}
	if sessionID == "" {
		return errors.New("browser omitted the target attachment ID")
	}
	defer func() {
		_ = browser.execute("", func(ctx context.Context) error {
			return target.DetachFromTarget().WithSessionID(sessionID).Do(ctx)
		})
	}()

	if err := browser.execute(sessionID, func(ctx context.Context) error {
		_, _, errorText, _, err := page.Navigate(canonicalOrigin).Do(ctx)
		if err != nil {
			return err
		}
		if errorText != "" {
			return fmt.Errorf("navigate to origin: %s", errorText)
		}
		return nil
	}); err != nil {
		return err
	}

	deadline := time.Now().Add(localStorageImportTimeout)
	originReady := false
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		var currentOrigin string
		var exception bool
		err := browser.execute(sessionID, func(ctx context.Context) error {
			result, exceptionDetails, err := runtime.Evaluate("location.origin").WithReturnByValue(true).Do(ctx)
			if err != nil {
				return err
			}
			exception = exceptionDetails != nil
			if result != nil && len(result.Value) > 0 {
				return json.Unmarshal(result.Value, &currentOrigin)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if !exception && currentOrigin == canonicalOrigin {
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
	if err := browser.execute(sessionID, func(ctx context.Context) error {
		return page.StopLoading().Do(ctx)
	}); err != nil {
		return err
	}

	var value *struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	var exception bool
	if err := browser.execute(sessionID, func(ctx context.Context) error {
		result, exceptionDetails, err := runtime.Evaluate(source).WithReturnByValue(true).Do(ctx)
		if err != nil {
			return err
		}
		exception = exceptionDetails != nil
		if result == nil || len(result.Value) == 0 {
			return nil
		}
		return json.Unmarshal(result.Value, &value)
	}); err != nil {
		return err
	}
	if exception || value == nil {
		return errors.New("browser could not evaluate the local storage import")
	}
	if value.Status == "failed" {
		return fmt.Errorf("browser rejected local storage: %s", value.Error)
	}
	if value.Status != "succeeded" {
		return errors.New("browser returned an invalid local storage import result")
	}
	return nil
}
