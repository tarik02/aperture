package browser

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	cdpio "github.com/chromedp/cdproto/io"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/target"
)

const (
	// FaviconMaxBytes bounds a favicon fetched from a page.
	FaviconMaxBytes = 64 << 10
	// FaviconVersionHeader carries the favicon's content version.
	FaviconVersionHeader = "X-Aperture-Favicon-Version"

	// The daemon waits five seconds for a page manifest, so fetching icons must finish sooner.
	faviconRefreshTimeout = 3 * time.Second
	// A failed icon URL is retried after this delay instead of on every page listing.
	faviconRetryDelay   = time.Minute
	faviconConcurrency  = 4
	faviconReadChunk    = 32 << 10
	faviconListMaxBytes = 4 << 20
)

type wrapperFavicon struct {
	iconURL     string
	image       []byte
	contentType string
	version     string
	failedAt    time.Time
}

type wrapperFaviconCache struct {
	refreshMu sync.Mutex
	mu        sync.Mutex
	entries   map[string]wrapperFavicon
}

// FaviconContentType classifies a favicon by its bytes, since servers often mislabel icons.
// Only raster image types and SVG documents are accepted.
func FaviconContentType(body []byte) (string, bool) {
	sniffed := http.DetectContentType(body)
	switch sniffed {
	case "image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/gif", "image/jpeg", "image/webp":
		return sniffed, true
	case "text/xml; charset=utf-8", "text/plain; charset=utf-8":
		trimmed := bytes.TrimLeft(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")), " \t\r\n")
		if bytes.HasPrefix(trimmed, []byte("<")) && bytes.Contains(bytes.ToLower(trimmed), []byte("<svg")) {
			return "image/svg+xml", true
		}
	}
	return "", false
}

// FaviconVersion is a short content hash that changes whenever the icon bytes change.
func FaviconVersion(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}

// faviconSourceURL returns the icon URL Chromium resolved for a page, or "" when the page is
// internal or the icon cannot be fetched through the page.
func faviconSourceURL(pageURL, iconURL string) string {
	parsedPage, err := url.Parse(pageURL)
	if err != nil || (parsedPage.Scheme != "http" && parsedPage.Scheme != "https") {
		return ""
	}
	parsedIcon, err := url.Parse(iconURL)
	if err != nil {
		return ""
	}
	switch parsedIcon.Scheme {
	case "http", "https", "data":
		return iconURL
	default:
		return ""
	}
}

type devToolsListTarget struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	URL        string `json:"url"`
	FaviconURL string `json:"faviconUrl"`
}

// devToolsIconURLs reads the favicon URL Chromium shows in each tab. CDP target info omits it;
// only the DevTools HTTP target list carries it.
func (session *liveSession) devToolsIconURLs(ctx context.Context) (map[string]string, error) {
	endpoint := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(session.runtime.values.CDPPort)) + "/json/list"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("list browser targets: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list browser targets: status %d", response.StatusCode)
	}
	var targets []devToolsListTarget
	if err := json.NewDecoder(io.LimitReader(response.Body, faviconListMaxBytes)).Decode(&targets); err != nil {
		return nil, fmt.Errorf("decode browser target list: %w", err)
	}
	icons := make(map[string]string, len(targets))
	for _, listed := range targets {
		if listed.Type == "page" {
			icons[listed.ID] = faviconSourceURL(listed.URL, listed.FaviconURL)
		}
	}
	return icons, nil
}

// favicons returns the current favicons of the given targets, fetching only icons whose URL
// changed since the last fetch. Targets without a usable icon are absent from the result.
func (session *liveSession) currentFavicons(targetIDs []string) (map[string]wrapperFavicon, error) {
	cache := &session.favicons
	cache.refreshMu.Lock()
	defer cache.refreshMu.Unlock()

	ctx, cancel := context.WithTimeout(session.runtime.ctx, faviconRefreshTimeout)
	defer cancel()
	icons, err := session.devToolsIconURLs(ctx)
	if err != nil {
		return nil, err
	}

	cache.mu.Lock()
	if cache.entries == nil {
		cache.entries = make(map[string]wrapperFavicon)
	}
	for targetID := range cache.entries {
		if _, ok := icons[targetID]; !ok {
			delete(cache.entries, targetID)
		}
	}
	stale := make([]string, 0, len(targetIDs))
	for _, targetID := range targetIDs {
		iconURL, ok := icons[targetID]
		if !ok {
			continue
		}
		cached, ok := cache.entries[targetID]
		if ok && cached.iconURL == iconURL && (cached.image != nil || iconURL == "" || time.Since(cached.failedAt) < faviconRetryDelay) {
			continue
		}
		if iconURL == "" {
			cache.entries[targetID] = wrapperFavicon{}
			continue
		}
		stale = append(stale, targetID)
	}
	cache.mu.Unlock()

	var wait sync.WaitGroup
	slots := make(chan struct{}, faviconConcurrency)
	for _, targetID := range stale {
		iconURL := icons[targetID]
		wait.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			image, err := session.fetchFavicon(ctx, targetID, iconURL)
			// An unfinished fetch says nothing about the icon, so the next listing retries it.
			if ctx.Err() != nil {
				return
			}
			entry := wrapperFavicon{iconURL: iconURL}
			contentType, valid := FaviconContentType(image)
			if err == nil && valid {
				entry.image = image
				entry.contentType = contentType
				entry.version = FaviconVersion(image)
			} else {
				entry.failedAt = time.Now()
			}
			cache.mu.Lock()
			cache.entries[targetID] = entry
			cache.mu.Unlock()
		})
	}
	wait.Wait()

	result := make(map[string]wrapperFavicon, len(targetIDs))
	cache.mu.Lock()
	for _, targetID := range targetIDs {
		if entry, ok := cache.entries[targetID]; ok && entry.image != nil {
			result[targetID] = entry
		}
	}
	cache.mu.Unlock()
	return result, nil
}

// fetchFavicon loads an icon through the page's own network context, so cookies, private hosts,
// and the HTTP cache behave as they did when Chromium loaded the icon for the tab.
func (session *liveSession) fetchFavicon(ctx context.Context, targetID, iconURL string) ([]byte, error) {
	if strings.HasPrefix(iconURL, "data:") {
		return decodeDataURL(iconURL)
	}
	// Connect the shared CDP client without holding its lock while the icon loads.
	if err := session.browser.execute("", func(context.Context) error { return nil }); err != nil {
		return nil, err
	}
	session.browser.mu.Lock()
	client := session.browser.client
	session.browser.mu.Unlock()
	if client == nil {
		return nil, errors.New("browser CDP connection closed")
	}

	sessionID, err := target.AttachToTarget(target.ID(targetID)).WithFlatten(true).Do(client.executorContext(ctx, ""))
	if err != nil {
		return nil, err
	}
	if sessionID == "" {
		return nil, errors.New("browser omitted the target attachment ID")
	}
	defer func() {
		detachCtx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionBrowserCommandTimeout)
		defer cancel()
		_ = target.DetachFromTarget().WithSessionID(sessionID).Do(client.executorContext(detachCtx, ""))
	}()
	pageCtx := client.executorContext(ctx, sessionID)

	frames, err := page.GetFrameTree().Do(pageCtx)
	if err != nil {
		return nil, err
	}
	if frames == nil || frames.Frame == nil {
		return nil, errors.New("page has no main frame")
	}
	resource, err := network.LoadNetworkResource(iconURL, &network.LoadNetworkResourceOptions{IncludeCredentials: true}).
		WithFrameID(frames.Frame.ID).Do(pageCtx)
	if err != nil {
		return nil, err
	}
	if resource == nil {
		return nil, errors.New("browser omitted the favicon resource")
	}
	if resource.Stream != "" {
		defer func() { _ = cdpio.Close(resource.Stream).Do(pageCtx) }()
	}
	if !resource.Success || resource.HTTPStatusCode < 200 || resource.HTTPStatusCode > 299 {
		return nil, fmt.Errorf("load favicon: status %v %s", resource.HTTPStatusCode, resource.NetErrorName)
	}
	if resource.Stream == "" {
		return nil, errors.New("browser omitted the favicon stream")
	}
	return readFaviconStream(pageCtx, resource.Stream)
}

func readFaviconStream(ctx context.Context, stream cdpio.StreamHandle) ([]byte, error) {
	var body []byte
	for {
		var chunk cdpio.ReadReturns
		if err := cdp.Execute(ctx, cdpio.CommandRead, cdpio.Read(stream).WithSize(faviconReadChunk), &chunk); err != nil {
			return nil, err
		}
		data := []byte(chunk.Data)
		if chunk.Base64encoded {
			decoded, err := base64.StdEncoding.DecodeString(chunk.Data)
			if err != nil {
				return nil, fmt.Errorf("decode favicon stream: %w", err)
			}
			data = decoded
		}
		body = append(body, data...)
		if len(body) > FaviconMaxBytes {
			return nil, errors.New("favicon is too large")
		}
		if chunk.EOF {
			return body, nil
		}
	}
}

// decodeDataURL decodes an RFC 2397 data URL; its media type is ignored because icons are sniffed.
func decodeDataURL(raw string) ([]byte, error) {
	header, payload, ok := strings.Cut(strings.TrimPrefix(raw, "data:"), ",")
	if !ok {
		return nil, errors.New("malformed data URL")
	}
	var body []byte
	if strings.HasSuffix(strings.ToLower(header), ";base64") {
		decoded, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(payload), ""))
		if err != nil {
			return nil, fmt.Errorf("decode data URL: %w", err)
		}
		body = decoded
	} else {
		decoded, err := url.PathUnescape(payload)
		if err != nil {
			return nil, fmt.Errorf("decode data URL: %w", err)
		}
		body = []byte(decoded)
	}
	if len(body) > FaviconMaxBytes {
		return nil, errors.New("favicon is too large")
	}
	return body, nil
}

// handleFavicon serves one target's favicon. Only the daemon calls it; it never counts as
// session activity.
func (r *wrapperRuntime) handleFavicon(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	targetID := req.URL.Query().Get("targetId")
	targets, err := r.liveSession.browser.targets()
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, err.Error())
		return
	}
	if targetID == "" || !slices.ContainsFunc(targets, func(listed liveSessionTarget) bool { return listed.ID == targetID }) {
		writeWrapperError(w, http.StatusNotFound, "favicon target not found")
		return
	}
	favicons, err := r.liveSession.currentFavicons([]string{targetID})
	if err != nil {
		writeWrapperError(w, http.StatusBadGateway, fmt.Sprintf("read favicon: %v", err))
		return
	}
	favicon, ok := favicons[targetID]
	if !ok {
		writeWrapperError(w, http.StatusNotFound, "favicon not found")
		return
	}
	w.Header().Set("Content-Type", favicon.contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(FaviconVersionHeader, favicon.version)
	_, _ = w.Write(favicon.image)
}
