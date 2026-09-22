package browser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/chromedp/cdproto"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/fetch"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/storage"
	"github.com/chromedp/cdproto/target"
)

const browserStateImportTimeout = time.Minute

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
		for _, origin := range input.StorageState.Origins {
			if err := browser.restoreOriginStorage(ctx, origin); err != nil {
				return fmt.Errorf("restore browser storage for %s: %w", origin.Origin, err)
			}
		}
		if err := browser.restoreCookies(input.StorageState.Cookies); err != nil {
			return fmt.Errorf("restore cookies: %w", err)
		}
	}
	if len(input.Targets) == 0 {
		return nil
	}

	existing, err := browser.targets()
	if err != nil {
		return fmt.Errorf("list existing browser targets: %w", err)
	}
	created := make([]string, len(input.Targets))
	activeIndex := -1
	remaining := len(input.Targets)
	for remaining > 0 {
		progress := false
		for index, target := range input.Targets {
			if created[index] != "" {
				continue
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			openerID := ""
			if target.OpenerTargetIndex != nil {
				openerID = created[*target.OpenerTargetIndex]
				if openerID == "" {
					continue
				}
			}
			targetID, err := browser.createInitialTarget(ctx, target, openerID)
			if err != nil {
				return fmt.Errorf("create initial browser target: %w", err)
			}
			created[index] = targetID
			remaining--
			progress = true
			if target.Active {
				activeIndex = index
			}
		}
		if !progress {
			return errors.New("initial target opener graph could not be resolved")
		}
	}
	browser.setInitialTargetOrder(created, activeIndex)
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
		if cookie.PartitionKey != nil {
			param.PartitionKey = &network.CookiePartitionKey{
				TopLevelSite:         cookie.PartitionKey.TopLevelSite,
				HasCrossSiteAncestor: cookie.PartitionKey.HasCrossSiteAncestor,
			}
		}
		params = append(params, param)
	}
	return browser.execute("", func(ctx context.Context) error {
		return storage.SetCookies(params).Do(ctx)
	})
}

const blankStorageDocument = "<!doctype html><meta charset=utf-8><title>Aperture storage import</title>"

func (browser *liveSessionBrowser) restoreOriginStorage(ctx context.Context, origin InitialStorageOrigin) error {
	canonicalOrigin, err := canonicalHTTPOrigin(origin.Origin)
	if err != nil {
		return err
	}
	if len(origin.AncestorOrigins) > 0 {
		return browser.restorePartitionedOriginStorage(ctx, origin, canonicalOrigin)
	}
	storageTypes := initialStorageTypes(origin)
	targetID, err := browser.createTarget("about:blank")
	if err != nil {
		return err
	}
	defer func() { _ = browser.closeTarget(targetID) }()

	encodedState, err := json.Marshal(origin)
	if err != nil {
		return err
	}
	source := originStorageRestoreSource(encodedState)
	return browser.withTargetSessionTimeout(browserStateImportTimeout, targetID, func(sessionID target.SessionID, commandCtx context.Context) error {
		if err := storage.ClearDataForOrigin(canonicalOrigin, strings.Join(storageTypes, ",")).Do(commandCtx); err != nil {
			return fmt.Errorf("clear destination origin storage: %w", err)
		}
		waiter, unregister := browser.registerFetchWaiter(sessionID)
		defer unregister()
		if err := network.SetBypassServiceWorker(true).Do(commandCtx); err != nil {
			return err
		}
		if err := fetch.Enable().WithPatterns([]*fetch.RequestPattern{{
			URLPattern:   "*",
			ResourceType: network.ResourceTypeDocument,
			RequestStage: fetch.RequestStageRequest,
		}}).Do(commandCtx); err != nil {
			return err
		}
		defer func() { _ = fetch.Disable().Do(commandCtx) }()

		if err := browser.sendAsync(commandCtx, cdproto.MethodType(page.CommandNavigate), page.Navigate(canonicalOrigin), sessionID); err != nil {
			return err
		}

		waitCtx, cancel := context.WithTimeout(ctx, browserStateImportTimeout)
		defer cancel()
		var paused *fetch.EventRequestPaused
		select {
		case <-waitCtx.Done():
			return errors.New("browser did not request the isolated origin document within 1 minute")
		case paused = <-waiter:
		}
		if paused == nil || paused.RequestID == "" {
			return errors.New("browser returned an invalid intercepted origin request")
		}
		if err := fetch.FulfillRequest(paused.RequestID, http.StatusOK).
			WithResponseHeaders([]*fetch.HeaderEntry{
				{Name: "Content-Type", Value: "text/html; charset=utf-8"},
				{Name: "Cache-Control", Value: "no-store"},
			}).
			WithBody(base64.StdEncoding.EncodeToString([]byte(blankStorageDocument))).
			Do(commandCtx); err != nil {
			return err
		}
		if err := browser.waitForTargetOrigin(waitCtx, commandCtx, canonicalOrigin); err != nil {
			return err
		}

		return browser.evaluateOriginStorage(commandCtx, source, nil)
	})
}

func (browser *liveSessionBrowser) restorePartitionedOriginStorage(ctx context.Context, origin InitialStorageOrigin, canonicalOrigin string) error {
	chain := make([]string, 0, len(origin.AncestorOrigins)+1)
	for _, ancestor := range origin.AncestorOrigins {
		canonical, err := canonicalHTTPOrigin(ancestor)
		if err != nil {
			return err
		}
		chain = append(chain, canonical)
	}
	chain = append(chain, canonicalOrigin)

	targetID, err := browser.createTarget("about:blank")
	if err != nil {
		return err
	}
	defer func() { _ = browser.closeTarget(targetID) }()

	encodedState, err := json.Marshal(origin)
	if err != nil {
		return err
	}
	source := originStorageRestoreSource(encodedState)
	return browser.withTargetSessionTimeout(browserStateImportTimeout, targetID, func(sessionID target.SessionID, commandCtx context.Context) error {
		if err := page.Enable().Do(commandCtx); err != nil {
			return err
		}
		if err := network.SetBypassServiceWorker(true).Do(commandCtx); err != nil {
			return err
		}
		waiter, unregister := browser.registerFetchWaiter(sessionID)
		defer unregister()
		if err := fetch.Enable().WithPatterns([]*fetch.RequestPattern{{
			URLPattern:   "*",
			ResourceType: network.ResourceTypeDocument,
			RequestStage: fetch.RequestStageRequest,
		}}).Do(commandCtx); err != nil {
			return err
		}
		defer func() { _ = fetch.Disable().Do(commandCtx) }()

		if err := browser.sendAsync(commandCtx, cdproto.MethodType(page.CommandNavigate), page.Navigate(chain[0]), sessionID); err != nil {
			return err
		}
		waitCtx, cancel := context.WithTimeout(ctx, browserStateImportTimeout)
		defer cancel()

		var frameID cdp.FrameID
		for index, expectedOrigin := range chain {
			var paused *fetch.EventRequestPaused
			select {
			case <-waitCtx.Done():
				return errors.New("browser did not request the partitioned storage document within 1 minute")
			case paused = <-waiter:
			}
			if paused == nil || paused.RequestID == "" || paused.FrameID == "" || paused.Request == nil {
				return errors.New("browser returned an invalid intercepted partition request")
			}
			requestURL, err := url.Parse(paused.Request.URL)
			if err != nil {
				return fmt.Errorf("browser requested invalid partition URL %q", paused.Request.URL)
			}
			requestOrigin, err := canonicalHTTPOrigin(requestURL.Scheme + "://" + requestURL.Host)
			if err != nil || requestOrigin != expectedOrigin {
				return fmt.Errorf("browser requested unexpected partition origin %q", paused.Request.URL)
			}
			body := blankStorageDocument
			if index+1 < len(chain) {
				body = partitionStorageDocument(chain[index+1])
			}
			if err := fetch.FulfillRequest(paused.RequestID, http.StatusOK).
				WithResponseHeaders([]*fetch.HeaderEntry{
					{Name: "Content-Type", Value: "text/html; charset=utf-8"},
					{Name: "Cache-Control", Value: "no-store"},
				}).
				WithBody(base64.StdEncoding.EncodeToString([]byte(body))).
				Do(commandCtx); err != nil {
				return err
			}
			frameID = paused.FrameID
		}

		contextID, err := browser.waitForFrameOrigin(waitCtx, commandCtx, frameID, canonicalOrigin)
		if err != nil {
			return err
		}
		var storageKeyResult struct {
			StorageKey string `json:"storageKey"`
		}
		if err := cdp.Execute(commandCtx, "Storage.getStorageKeyForFrame", struct {
			FrameID cdp.FrameID `json:"frameId"`
		}{FrameID: frameID}, &storageKeyResult); err != nil {
			return fmt.Errorf("resolve destination storage partition: %w", err)
		}
		if storageKeyResult.StorageKey == "" {
			return errors.New("browser omitted the destination storage partition key")
		}
		if err := storage.ClearDataForStorageKey(storageKeyResult.StorageKey, strings.Join(initialStorageTypes(origin), ",")).Do(commandCtx); err != nil {
			return fmt.Errorf("clear destination storage partition: %w", err)
		}
		return browser.evaluateOriginStorage(commandCtx, source, &contextID)
	})
}

func initialStorageTypes(origin InitialStorageOrigin) []string {
	storageTypes := []string{"cookies", "local_storage"}
	if origin.IndexedDB != nil {
		storageTypes = append(storageTypes, "indexeddb")
	}
	if origin.CacheStorage != nil {
		storageTypes = append(storageTypes, "cache_storage")
	}
	if origin.OPFS != nil {
		storageTypes = append(storageTypes, "file_systems")
	}
	return storageTypes
}

func partitionStorageDocument(childOrigin string) string {
	return `<!doctype html><meta charset=utf-8><title>Aperture storage partition import</title><iframe src="` + html.EscapeString(childOrigin) + `"></iframe>`
}

func (browser *liveSessionBrowser) waitForFrameOrigin(ctx, commandCtx context.Context, frameID cdp.FrameID, expected string) (runtime.ExecutionContextID, error) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		contextID, err := page.CreateIsolatedWorld(frameID).WithWorldName("aperture-storage-import").Do(commandCtx)
		if err == nil && contextID != 0 {
			result, exceptionDetails, evaluateErr := runtime.Evaluate("location.origin").
				WithContextID(contextID).
				WithReturnByValue(true).
				Do(commandCtx)
			var currentOrigin string
			if evaluateErr == nil && exceptionDetails == nil && result != nil && len(result.Value) > 0 {
				evaluateErr = json.Unmarshal(result.Value, &currentOrigin)
			}
			if evaluateErr == nil && currentOrigin == expected {
				return contextID, nil
			}
		}
		select {
		case <-ctx.Done():
			return 0, errors.New("browser did not enter the partitioned storage origin within 1 minute")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) evaluateOriginStorage(commandCtx context.Context, source string, contextID *runtime.ExecutionContextID) error {
	params := runtime.Evaluate(source).WithAwaitPromise(true).WithReturnByValue(true)
	if contextID != nil {
		params = params.WithContextID(*contextID)
	}
	result, exceptionDetails, err := params.Do(commandCtx)
	if err != nil {
		return err
	}
	var value *struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if result != nil && len(result.Value) > 0 {
		if err := json.Unmarshal(result.Value, &value); err != nil {
			return err
		}
	}
	if exceptionDetails != nil || value == nil {
		return errors.New("browser could not evaluate the origin storage import")
	}
	if value.Status == "failed" {
		return fmt.Errorf("browser rejected origin storage: %s", value.Error)
	}
	if value.Status != "succeeded" {
		return errors.New("browser returned an invalid origin storage import result")
	}
	return nil
}

func (browser *liveSessionBrowser) waitForTargetOrigin(ctx, commandCtx context.Context, expected string) error {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		result, exceptionDetails, err := runtime.Evaluate("location.origin").WithReturnByValue(true).Do(commandCtx)
		var currentOrigin string
		if err == nil && exceptionDetails == nil && result != nil && len(result.Value) > 0 {
			err = json.Unmarshal(result.Value, &currentOrigin)
		}
		if err == nil && currentOrigin == expected {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("browser did not enter the storage origin within 1 minute")
		case <-ticker.C:
		}
	}
}

func (browser *liveSessionBrowser) createInitialTarget(ctx context.Context, target InitialTarget, openerID string) (string, error) {
	var targetID string
	var err error
	if openerID == "" {
		targetID, err = browser.createTarget("about:blank")
	} else {
		targetID, err = browser.createChildTarget(ctx, openerID)
	}
	if err != nil {
		return "", err
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = browser.closeTarget(targetID)
		}
	}()

	sessionStorage := make([]InitialTargetStorageOrigin, len(target.SessionStorage))
	for index, origin := range target.SessionStorage {
		canonical, err := canonicalHTTPOrigin(origin.Origin)
		if err != nil {
			return "", err
		}
		sessionStorage[index] = origin
		sessionStorage[index].Origin = canonical
	}
	state, err := json.Marshal(struct {
		Scroll        *InitialScrollPosition `json:"scroll,omitempty"`
		DocumentState *InitialDocumentState  `json:"documentState,omitempty"`
		URL           string                 `json:"url"`
	}{
		Scroll:        target.Scroll,
		DocumentState: target.DocumentState,
		URL:           target.URL,
	})
	if err != nil {
		return "", err
	}
	documentSource := targetStateRestoreSource(state)
	remainingSessionStorageScripts := make(map[string]string, len(sessionStorage))
	sessionID, err := browser.waitForObservedTargetSession(ctx, targetID)
	if err != nil {
		return "", err
	}
	err = browser.executeWithTimeout(browserStateImportTimeout, sessionID, func(commandCtx context.Context) error {
		if err := page.Enable().Do(commandCtx); err != nil {
			return err
		}
		for _, origin := range sessionStorage {
			encoded, err := json.Marshal(origin)
			if err != nil {
				return err
			}
			identifier, err := page.AddScriptToEvaluateOnNewDocument(targetSessionStorageRestoreSource(encoded)).Do(commandCtx)
			if err != nil {
				return err
			}
			if identifier == "" {
				return errors.New("browser omitted the session storage preload script identifier")
			}
			remainingSessionStorageScripts[origin.Origin] = string(identifier)
		}
		documentIdentifier, err := page.AddScriptToEvaluateOnNewDocument(documentSource).Do(commandCtx)
		if err != nil {
			return err
		}
		if documentIdentifier == "" {
			return errors.New("browser omitted the target preload script identifier")
		}
		_, _, errorText, _, err := page.Navigate(target.URL).Do(commandCtx)
		if err != nil {
			return err
		}
		if errorText != "" {
			return fmt.Errorf("navigate initial target: %s", errorText)
		}
		if err := browser.waitForTargetNavigation(ctx, commandCtx, target.DocumentState != nil); err != nil {
			return err
		}
		if err := page.RemoveScriptToEvaluateOnNewDocument(documentIdentifier).Do(commandCtx); err != nil {
			return err
		}
		return browser.removeLoadedSessionStorageScripts(commandCtx, remainingSessionStorageScripts)
	})
	if err != nil {
		return "", err
	}
	succeeded = true
	browser.registerInitialSessionStorageScripts(targetID, remainingSessionStorageScripts)
	return targetID, nil
}

func (browser *liveSessionBrowser) removeLoadedSessionStorageScripts(commandCtx context.Context, scripts map[string]string) error {
	frameTree, err := page.GetFrameTree().Do(commandCtx)
	if err != nil {
		return err
	}
	loaded := make(map[string]struct{})
	var collect func(*page.FrameTree)
	collect = func(tree *page.FrameTree) {
		if tree == nil || tree.Frame == nil {
			return
		}
		if parsed, err := url.Parse(tree.Frame.URL); err == nil {
			if origin, err := canonicalHTTPOrigin(parsed.Scheme + "://" + parsed.Host); err == nil {
				loaded[origin] = struct{}{}
			}
		}
		for _, child := range tree.ChildFrames {
			collect(child)
		}
	}
	collect(frameTree)
	for origin, identifier := range scripts {
		if _, exists := loaded[origin]; !exists {
			continue
		}
		if err := page.RemoveScriptToEvaluateOnNewDocument(page.ScriptIdentifier(identifier)).Do(commandCtx); err != nil {
			return err
		}
		delete(scripts, origin)
	}
	return nil
}

func (browser *liveSessionBrowser) waitForTargetNavigation(ctx, commandCtx context.Context, waitForDocumentState bool) error {
	waitCtx, cancel := context.WithTimeout(ctx, browserStateImportTimeout)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		var value *struct {
			Href          string `json:"href"`
			ReadyState    string `json:"readyState"`
			DocumentState *struct {
				Status string `json:"status"`
				Error  string `json:"error"`
			} `json:"documentState"`
		}
		result, _, err := runtime.Evaluate(
			fmt.Sprintf(
				"({ href: location.href, readyState: document.readyState, documentState: globalThis[Symbol.for(%q)] || null })",
				initialDocumentStateSymbol,
			),
		).WithReturnByValue(true).Do(commandCtx)
		if err == nil && result != nil && len(result.Value) > 0 {
			err = json.Unmarshal(result.Value, &value)
		}
		if err == nil && value != nil {
			if value.DocumentState != nil && value.DocumentState.Status == "failed" {
				return fmt.Errorf("restore initial document state: %s", value.DocumentState.Error)
			}
			stateReady := !waitForDocumentState || (value.DocumentState != nil && value.DocumentState.Status == "succeeded")
			if value.Href != "" && value.Href != "about:blank" && value.ReadyState == "complete" && stateReady {
				return nil
			}
		}
		select {
		case <-waitCtx.Done():
			return errors.New("initial target did not navigate within 1 minute")
		case <-ticker.C:
		}
	}
}

func originStorageRestoreSource(state []byte) string {
	return fmt.Sprintf(`(async () => {
  try {
    const state = %s;
    const fromBase64 = (body) => {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };
    const cryptoKeyImportAlgorithm = (algorithm) => {
      if (algorithm.hash !== undefined) {
        return { name: algorithm.name, hash: { name: algorithm.hash }, ...(algorithm.length === undefined ? {} : { length: algorithm.length }) };
      }
      if (algorithm.namedCurve !== undefined) {
        return { name: algorithm.name, namedCurve: algorithm.namedCurve };
      }
      return { name: algorithm.name, ...(algorithm.length === undefined ? {} : { length: algorithm.length }) };
    };
    const decode = async (encoded) => {
      const serialized = JSON.parse(encoded);
      const values = new Array(serialized.nodes.length);
      const constructors = {
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array,
        BigUint64Array, DataView,
      };
      for (let index = 0; index < serialized.nodes.length; index++) {
        const node = serialized.nodes[index];
        switch (node.type) {
          case "array": values[index] = []; break;
          case "object": values[index] = {}; break;
          case "map": values[index] = new Map(); break;
          case "set": values[index] = new Set(); break;
          case "date": values[index] = new Date(node.value); break;
          case "regexp": values[index] = new RegExp(node.source, node.flags); break;
          case "error": {
            const error = new Error(node.message);
            error.name = node.name;
            if (node.stack !== undefined) error.stack = node.stack;
            values[index] = error;
            break;
          }
          case "array-buffer": values[index] = fromBase64(node.body).buffer; break;
          case "typed-array": {
            const constructor = constructors[node.constructor];
            if (!constructor) throw new Error("unsupported typed array " + node.constructor);
            const bytes = fromBase64(node.body);
            values[index] = node.constructor === "DataView"
              ? new DataView(bytes.buffer)
              : new constructor(bytes.buffer);
            break;
          }
          case "blob": values[index] = new Blob([fromBase64(node.body)], { type: node.mimeType }); break;
          case "file": values[index] = new File([fromBase64(node.body)], node.name, {
            type: node.mimeType,
            lastModified: node.lastModified,
          }); break;
          case "crypto-key": values[index] = await crypto.subtle.importKey(
            node.format,
            fromBase64(node.body),
            cryptoKeyImportAlgorithm(node.algorithm),
            true,
            node.usages,
          ); break;
          default: throw new Error("unsupported structured-clone node " + node.type);
        }
      }
      const token = (value) => {
        if (value === null || typeof value !== "object") return value;
        if (Object.hasOwn(value, "ref")) return values[value.ref];
        switch (value.type) {
          case "undefined": return undefined;
          case "bigint": return BigInt(value.value);
          case "number": {
            if (value.value === "nan") return NaN;
            if (value.value === "positive-infinity") return Infinity;
            if (value.value === "negative-infinity") return -Infinity;
            if (value.value === "negative-zero") return -0;
            break;
          }
        }
        throw new Error("unsupported structured-clone token");
      };
      for (let index = 0; index < serialized.nodes.length; index++) {
        const node = serialized.nodes[index];
        const value = values[index];
        if (node.type === "array") {
          for (const item of node.values) value.push(token(item));
        } else if (node.type === "object") {
          for (const [name, item] of node.properties) Object.defineProperty(value, name, {
            value: token(item), enumerable: true, configurable: true, writable: true,
          });
        } else if (node.type === "map") {
          for (const [key, item] of node.entries) value.set(token(key), token(item));
        } else if (node.type === "set") {
          for (const item of node.values) value.add(token(item));
        } else if (node.type === "error") {
          value.cause = token(node.cause);
        }
      }
      return token(serialized.root);
    };
    const keyPath = (specification) => {
      if (specification.kind === "none") return null;
      if (specification.kind === "string") return specification.value[0];
      return specification.value;
    };
    const transactionDone = (transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
    const openDatabase = (database) => new Promise((resolve, reject) => {
      const request = indexedDB.open(database.name, database.version);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
      request.onupgradeneeded = () => {
        const opened = request.result;
        for (const storeState of database.objectStores) {
          const store = opened.createObjectStore(storeState.name, {
            keyPath: keyPath(storeState.keyPath),
            autoIncrement: storeState.autoIncrement,
          });
          for (const index of storeState.indexes) {
            store.createIndex(index.name, keyPath(index.keyPath), {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
    });

    localStorage.clear();
    for (const entry of state.localStorage) localStorage.setItem(entry.name, entry.value);
    for (const databaseState of state.indexedDB || []) {
      const database = await openDatabase(databaseState);
      try {
        for (const storeState of databaseState.objectStores) {
          const decoded = await Promise.all(storeState.records.map(async (record) => ({
            key: await decode(record.key),
            value: await decode(record.value),
          })));
          if (decoded.length === 0) continue;
          const transaction = database.transaction(storeState.name, "readwrite");
          const store = transaction.objectStore(storeState.name);
          for (const record of decoded) {
            if (store.keyPath === null) store.put(record.value, record.key);
            else store.put(record.value);
          }
          await transactionDone(transaction);
        }
      } finally {
        database.close();
      }
    }
    if (state.cacheStorage !== undefined && typeof caches === "undefined") {
      if (state.cacheStorage.length > 0) throw new Error("Cache Storage is unavailable");
    } else if (state.cacheStorage !== undefined) {
      for (const cacheName of await caches.keys()) await caches.delete(cacheName);
      for (const cacheState of state.cacheStorage || []) {
        const cache = await caches.open(cacheState.name);
        for (const entry of cacheState.entries) {
          const responseBody = [204, 205, 304].includes(entry.responseStatus)
            ? null
            : fromBase64(entry.responseBody);
          await cache.put(
            new Request(entry.url, { headers: entry.requestHeaders }),
            new Response(responseBody, {
              status: entry.responseStatus,
              statusText: entry.responseStatusText,
              headers: entry.responseHeaders,
            }),
          );
        }
      }
    }
    if (state.opfs !== undefined && typeof navigator.storage.getDirectory === "function") {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
      for (const fileState of state.opfs || []) {
        const parts = fileState.path.split("/");
        const fileName = parts.pop();
        let directory = root;
        for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
        const file = await directory.getFileHandle(fileName, { create: true });
        const writer = await file.createWritable();
        await writer.write(fromBase64(fileState.body));
        await writer.close();
      }
    } else if ((state.opfs || []).length > 0) {
      throw new Error("OPFS is unavailable");
    }
    return { status: "succeeded" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  }
})()`, state)
}
