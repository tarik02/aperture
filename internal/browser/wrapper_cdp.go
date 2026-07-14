package browser

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

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

	if targetPath == "/" {
		targetPath = "/json/version"
	}
	target := &url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort("127.0.0.1", strconv.Itoa(r.values.CDPPort)),
		Path:     targetPath,
		RawQuery: wrapperCDPTargetRawQuery(req.URL),
	}
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{
		Scheme: target.Scheme,
		Host:   target.Host,
	})
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
	proxy.Director = func(outReq *http.Request) {
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
	if len(parts) < 4 || parts[0] != "sessions" || parts[2] != "cdp" || !strings.HasPrefix(parts[3], "aps_") {
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
		if len(baseParts) < 4 || baseParts[0] != "sessions" || baseParts[2] != "cdp" || !strings.HasPrefix(baseParts[3], "aps_") {
			return ""
		}
		return "/" + strings.Join(baseParts, "/")
	}
	if len(parts) >= 4 && parts[0] == "sessions" && parts[2] == "cdp" && strings.HasPrefix(parts[3], "aps_") {
		return "/" + strings.Join(parts[:4], "/")
	}
	return ""
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
