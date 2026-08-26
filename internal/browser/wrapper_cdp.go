package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

const maximumRestrictedCDPConnections = 7

func (r *wrapperRuntime) handleCDPProxy(w http.ResponseWriter, req *http.Request) {
	if r.values.CDPPort <= 0 {
		writeWrapperError(w, http.StatusServiceUnavailable, "browser cdp port is not available")
		return
	}
	role := strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role"))
	if role == "editor" || role == "viewer" {
		r.mu.Lock()
		if r.restrictedCDPConnections >= maximumRestrictedCDPConnections {
			r.mu.Unlock()
			writeWrapperError(w, http.StatusServiceUnavailable, "shared CDP connection limit reached")
			return
		}
		r.restrictedCDPConnections++
		r.cdpConnections++
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			r.restrictedCDPConnections--
			r.cdpConnections--
			r.mu.Unlock()
		}()
		r.handleRestrictedCDPProxy(w, req, role)
		return
	}

	r.mu.Lock()
	r.cdpConnections++
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.cdpConnections--
		r.mu.Unlock()
	}()

	target := &url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort("127.0.0.1", strconv.Itoa(r.values.CDPPort)),
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
	proxy.ServeHTTP(w, req)
}

func (r *wrapperRuntime) handleRestrictedCDPProxy(w http.ResponseWriter, req *http.Request, role string) {
	client, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = client.Close(websocket.StatusNormalClosure, "done") }()
	upstreamURL := url.URL{
		Scheme:   "ws",
		Host:     net.JoinHostPort("127.0.0.1", strconv.Itoa(r.values.CDPPort)),
		Path:     req.URL.Path,
		RawQuery: req.URL.RawQuery,
	}
	upstream, _, err := websocket.Dial(req.Context(), upstreamURL.String(), nil)
	if err != nil {
		_ = client.Close(websocket.StatusInternalError, "browser CDP unavailable")
		return
	}
	defer func() { _ = upstream.Close(websocket.StatusNormalClosure, "done") }()
	client.SetReadLimit(cdpDiscoveryMessageLimit)
	upstream.SetReadLimit(cdpDiscoveryMessageLimit)

	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	var clientWrite sync.Mutex
	errors := make(chan error, 2)
	go func() {
		for {
			messageType, body, err := upstream.Read(ctx)
			if err != nil {
				errors <- err
				return
			}
			clientWrite.Lock()
			err = client.Write(ctx, messageType, body)
			clientWrite.Unlock()
			if err != nil {
				errors <- err
				return
			}
		}
	}()
	go func() {
		for {
			messageType, body, err := client.Read(ctx)
			if err != nil {
				errors <- err
				return
			}
			requestID, allowed := collaborationCDPRequestAllowed(role, body)
			if !allowed {
				if requestID != nil {
					response, _ := json.Marshal(map[string]any{
						"id":    requestID,
						"error": map[string]any{"code": -32000, "message": "CDP method is not allowed by this collaboration capability"},
					})
					clientWrite.Lock()
					err = client.Write(ctx, websocket.MessageText, response)
					clientWrite.Unlock()
					if err != nil {
						errors <- err
						return
					}
				}
				continue
			}
			if err := upstream.Write(ctx, messageType, body); err != nil {
				errors <- err
				return
			}
		}
	}()
	<-errors
}

func collaborationCDPRequestAllowed(role string, body []byte) (any, bool) {
	var request struct {
		ID     any             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &request); err != nil || request.Method == "" {
		return request.ID, false
	}
	if strings.HasPrefix(request.Method, "Input.") {
		return request.ID, false
	}
	switch request.Method {
	case "Target.setDiscoverTargets", "Target.getTargets", "Target.attachToTarget", "Target.detachFromTarget",
		"Page.enable", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck":
		return request.ID, true
	case "Target.activateTarget", "Target.createTarget", "Target.closeTarget", "Page.bringToFront", "Page.navigate", "Page.reload", "Page.stopLoading", "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Emulation.setDeviceMetricsOverride":
		return request.ID, role == "editor"
	case "Runtime.evaluate":
		var params struct {
			Expression string `json:"expression"`
		}
		if json.Unmarshal(request.Params, &params) != nil {
			return request.ID, false
		}
		return request.ID, params.Expression == "document.readyState" || params.Expression == "({ focused: document.hasFocus(), visible: document.visibilityState === 'visible' })"
	default:
		return request.ID, false
	}
}

func (r *wrapperRuntime) handleCDPDiscovery(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.values.CDPPort <= 0 {
		writeWrapperError(w, http.StatusServiceUnavailable, "browser cdp port is not available")
		return
	}
	targetPath, publicBasePath := wrapperCDPDiscoveryRoute(req.URL.Path, req.Header.Get("X-Forwarded-Uri"))
	if targetPath == "" || !isWrapperCDPDiscoveryPath(targetPath) {
		http.NotFound(w, req)
		return
	}
	if strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role")) == "viewer" && strings.HasPrefix(targetPath, "/json/new") {
		writeWrapperError(w, http.StatusForbidden, "viewer cannot create browser targets")
		return
	}

	if targetPath == "/" {
		targetPath = "/json/version"
	}
	target := &url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort("127.0.0.1", strconv.Itoa(r.values.CDPPort)),
		Path:     targetPath,
		RawQuery: wrapperCDPTargetRawQuery(req.URL),
	}
	proxy := &httputil.ReverseProxy{}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
	proxy.Rewrite = func(proxyReq *httputil.ProxyRequest) {
		outReq := proxyReq.Out
		outReq.URL.Scheme = target.Scheme
		outReq.URL.Host = target.Host
		outReq.URL.Path = target.Path
		outReq.URL.RawPath = ""
		outReq.URL.RawQuery = target.RawQuery
		outReq.Host = target.Host
		outReq.RequestURI = ""
		outReq.Header.Del("Accept-Encoding")
		outReq.Header.Del("Authorization")
		outReq.Header.Del("Cookie")
		outReq.Header.Del("Sec-WebSocket-Protocol")
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		return rewriteWrapperCDPDiscoveryResponse(resp, req, publicBasePath)
	}
	proxy.ServeHTTP(w, req)
}

func wrapperCDPDiscoveryRoute(path, forwardedURI string) (string, string) {
	if path == "/" || strings.HasPrefix(path, "/json") {
		return path, publicCDPBasePathFromForwardedURI(forwardedURI)
	}

	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 4 || parts[0] != "sessions" || parts[2] != "cdp" || !isWrapperSessionAccessToken(parts[3]) {
		return "", ""
	}
	basePath := "/" + strings.Join(parts[:4], "/")
	if len(parts) == 4 {
		return "/json/version", basePath
	}
	return "/" + strings.Join(parts[4:], "/"), basePath
}

func isWrapperCDPDiscoveryPath(path string) bool {
	switch path {
	case "/", "/json", "/json/list", "/json/version", "/json/new":
		return true
	default:
		return strings.HasPrefix(path, "/json/new?")
	}
}

func wrapperCDPTargetRawQuery(source *url.URL) string {
	if _, ok := source.Query()["token"]; !ok {
		return source.RawQuery
	}
	values := source.Query()
	values.Del("token")
	return values.Encode()
}

func rewriteWrapperCDPDiscoveryResponse(resp *http.Response, req *http.Request, basePath string) error {
	if !isWrapperCDPDiscoveryPath(resp.Request.URL.Path) {
		return nil
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if contentType != "" && !strings.Contains(contentType, "json") {
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if err := resp.Body.Close(); err != nil {
		return err
	}

	var payload any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		resp.Body = io.NopCloser(bytes.NewReader(body))
		return nil
	}

	rewriteWrapperCDPDiscoveryValue(payload, req, basePath)

	rewritten, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp.Body = io.NopCloser(bytes.NewReader(rewritten))
	resp.ContentLength = int64(len(rewritten))
	resp.Header.Set("Content-Type", "application/json")
	resp.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
	return nil
}

func rewriteWrapperCDPDiscoveryValue(value any, req *http.Request, basePath string) {
	switch typed := value.(type) {
	case map[string]any:
		if rawURL, ok := typed["webSocketDebuggerUrl"].(string); ok {
			typed["webSocketDebuggerUrl"] = publicCDPWebSocketURL(req, basePath, rawURL)
		}
		for _, child := range typed {
			rewriteWrapperCDPDiscoveryValue(child, req, basePath)
		}
	case []any:
		for _, child := range typed {
			rewriteWrapperCDPDiscoveryValue(child, req, basePath)
		}
	}
}

func publicCDPBasePathFromForwardedURI(forwardedURI string) string {
	parsed, err := url.ParseRequestURI(forwardedURI)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/"), "/")
	for index, part := range parts {
		if part != "json" {
			continue
		}
		baseParts := parts[:index]
		if len(baseParts) < 4 || baseParts[0] != "sessions" || baseParts[2] != "cdp" || !isWrapperSessionAccessToken(baseParts[3]) {
			return ""
		}
		return "/" + strings.Join(baseParts, "/")
	}
	if len(parts) >= 4 && parts[0] == "sessions" && parts[2] == "cdp" && isWrapperSessionAccessToken(parts[3]) {
		return "/" + strings.Join(parts[:4], "/")
	}
	return ""
}

func isWrapperSessionAccessToken(value string) bool {
	return strings.HasPrefix(value, "aps_") || strings.HasPrefix(value, "ape_") || strings.HasPrefix(value, "apv_")
}

func publicCDPWebSocketURL(req *http.Request, basePath, rawTargetURL string) string {
	target, err := url.Parse(rawTargetURL)
	if err != nil || basePath == "" {
		return rawTargetURL
	}

	publicPath := strings.TrimRight(basePath, "/")
	if targetPath := strings.TrimLeft(target.Path, "/"); targetPath != "" {
		publicPath += "/" + targetPath
	}

	publicURL := url.URL{
		Scheme: publicWebSocketScheme(req),
		Host:   publicHost(req),
		Path:   publicPath,
	}
	values := target.Query()
	values.Del("token")
	publicURL.RawQuery = values.Encode()
	return publicURL.String()
}

func publicWebSocketScheme(req *http.Request) string {
	proto := forwardedProto(req)
	if proto == "https" || proto == "wss" || req.TLS != nil {
		return "wss"
	}
	if !isLocalOrSingleLabelHost(publicHost(req)) {
		return "wss"
	}
	return "ws"
}

func publicHost(req *http.Request) string {
	if host := firstForwardedValue(req.Header.Get("X-Forwarded-Host")); host != "" {
		return host
	}
	return req.Host
}

func firstForwardedValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if before, _, ok := strings.Cut(value, ","); ok {
		return strings.TrimSpace(before)
	}
	return value
}

func forwardedProto(req *http.Request) string {
	for _, header := range []string{
		req.Header.Get("X-Forwarded-Proto"),
		req.Header.Get("X-Forwarded-Protocol"),
		req.Header.Get("X-Url-Scheme"),
	} {
		for _, part := range strings.Split(header, ",") {
			proto := strings.ToLower(strings.TrimSpace(part))
			switch proto {
			case "https", "wss":
				return proto
			case "http", "ws":
				return proto
			}
		}
	}

	if strings.EqualFold(strings.TrimSpace(req.Header.Get("X-Forwarded-Ssl")), "on") {
		return "https"
	}

	for _, field := range strings.Split(req.Header.Get("Forwarded"), ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(field), "=")
		if !ok || !strings.EqualFold(key, "proto") {
			continue
		}
		proto := strings.ToLower(strings.Trim(value, `"`))
		if proto == "https" || proto == "http" {
			return proto
		}
	}

	return ""
}

func isLocalOrSingleLabelHost(host string) bool {
	parsedHost, _, err := net.SplitHostPort(host)
	if err == nil {
		host = parsedHost
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "" || host == "localhost" || !strings.Contains(host, ".") {
		return true
	}

	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}
