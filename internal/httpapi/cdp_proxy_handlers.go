package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

const cdpWebSocketProtocol = "aperture-cdp.v1"
const cdpBasePathContextKey = "cdpBasePath"

type cdpWebSocketAuthMode string

const (
	cdpWebSocketAuthModeAPI    cdpWebSocketAuthMode = "api"
	cdpWebSocketAuthModePublic cdpWebSocketAuthMode = "public"
)

func (s *Server) proxyAPICDP(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	port, err := s.Sessions.RunningCDPPort(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}

	targetPath := c.Param("path")
	if targetPath == "" {
		targetPath = "/"
	} else if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	target := &url.URL{
		Scheme:   "http",
		Host:     fmt.Sprintf("127.0.0.1:%d", port),
		Path:     targetPath,
		RawQuery: c.Request.URL.RawQuery,
	}

	req := c.Request.Clone(c.Request.Context())
	sanitizeCDPProxyRequest(req)

	if isWebSocketUpgrade(req) {
		if err := proxyCDPWebSocket(c.Request.Context(), c.Writer, req, target, cdpWebSocketAuthModeAPI); err != nil {
			if !c.Writer.Written() {
				WriteError(c, err)
			}
		}
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(&url.URL{
		Scheme: "http",
		Host:   target.Host,
	})
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		if !c.Writer.Written() {
			WriteError(c, proxyErr)
		}
	}
	proxy.Director = func(outReq *http.Request) {
		outReq.URL.Scheme = target.Scheme
		outReq.URL.Host = target.Host
		outReq.URL.Path = target.Path
		outReq.URL.RawPath = ""
		outReq.URL.RawQuery = target.RawQuery
		outReq.Host = target.Host
		outReq.RequestURI = ""
		sanitizeCDPProxyRequest(outReq)
	}
	proxy.ServeHTTP(c.Writer, req)
}

func (s *Server) proxyPublicCDP(c *gin.Context) {
	if s.Sessions == nil {
		c.Status(http.StatusServiceUnavailable)
		return
	}

	sessionID := c.Param("sessionId")
	credential := cdpForwardAuthCredential(c)
	port, err := s.Sessions.AuthorizedCDPPort(c.Request.Context(), sessionID, credential)
	if err != nil {
		status, message := mapForwardAuthError(err)
		c.String(status, message)
		return
	}

	targetPath := c.Param("path")
	if targetPath == "" || targetPath == "/" {
		targetPath = "/json/version"
	}
	if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	targetRawQuery := cdpTargetRawQuery(c.Request.URL)
	if isWebSocketUpgrade(c.Request) && targetPath == "/json/version" {
		browserWebSocketURL, err := browserWebSocketURL(c.Request.Context(), port)
		if err != nil {
			c.String(http.StatusBadGateway, err.Error())
			return
		}
		targetPath = browserWebSocketURL.Path
		targetRawQuery = browserWebSocketURL.RawQuery
	}

	target := &url.URL{
		Scheme:   "http",
		Host:     fmt.Sprintf("127.0.0.1:%d", port),
		Path:     targetPath,
		RawQuery: targetRawQuery,
	}

	req := c.Request.Clone(c.Request.Context())
	sanitizeCDPProxyRequest(req)

	if isWebSocketUpgrade(req) {
		if err := proxyCDPWebSocket(c.Request.Context(), c.Writer, req, target, cdpWebSocketAuthModePublic); err != nil {
			if !c.Writer.Written() {
				c.String(http.StatusBadGateway, err.Error())
			}
		}
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(&url.URL{
		Scheme: "http",
		Host:   target.Host,
	})
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		if !c.Writer.Written() {
			http.Error(w, proxyErr.Error(), http.StatusBadGateway)
		}
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
		sanitizeCDPProxyRequest(outReq)
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		return rewriteCDPDiscoveryResponse(resp, c, sessionID, rawCDPTokenFromCredential(credential))
	}
	proxy.ServeHTTP(c.Writer, req)
}

func sanitizeCDPProxyRequest(req *http.Request) {
	req.Header.Del("Authorization")
	req.Header.Del(auth.TenantHeader)
}

func isWebSocketUpgrade(req *http.Request) bool {
	if !strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		return false
	}
	return strings.Contains(strings.ToLower(req.Header.Get("Connection")), "upgrade")
}

func proxyCDPWebSocket(ctx context.Context, w http.ResponseWriter, req *http.Request, target *url.URL, mode cdpWebSocketAuthMode) error {
	targetURL := *target
	targetURL.Scheme = "ws"

	if mode == cdpWebSocketAuthModeAPI && !hasWebSocketProtocol(req.Header.Get("Sec-WebSocket-Protocol"), cdpWebSocketProtocol) {
		return fmt.Errorf("websocket protocol %s is required", cdpWebSocketProtocol)
	}

	backend, _, err := websocket.Dial(ctx, targetURL.String(), &websocket.DialOptions{
		Host: target.Host,
	})
	if err != nil {
		return err
	}
	defer backend.CloseNow()
	backend.SetReadLimit(-1)

	acceptOptions := &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	}
	if mode == cdpWebSocketAuthModeAPI {
		acceptOptions.Subprotocols = []string{cdpWebSocketProtocol}
	}
	client, err := websocket.Accept(w, req, acceptOptions)
	if err != nil {
		return err
	}
	defer client.CloseNow()
	client.SetReadLimit(-1)

	errc := make(chan error, 2)
	go func() {
		errc <- copyWebSocketMessages(ctx, backend, client)
	}()
	go func() {
		errc <- copyWebSocketMessages(ctx, client, backend)
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errc:
		if isExpectedWebSocketClose(err) {
			return nil
		}
		return err
	}
}

func copyWebSocketMessages(ctx context.Context, dst, src *websocket.Conn) error {
	for {
		messageType, reader, err := src.Reader(ctx)
		if err != nil {
			closePeerWebSocket(dst, err)
			return err
		}

		writer, err := dst.Writer(ctx, messageType)
		if err != nil {
			return err
		}
		if _, err := io.Copy(writer, reader); err != nil {
			_ = dst.Close(websocket.StatusInternalError, "cdp proxy copy failed")
			return err
		}
		if err := writer.Close(); err != nil {
			return err
		}
	}
}

func closePeerWebSocket(conn *websocket.Conn, err error) {
	status := websocket.CloseStatus(err)
	switch status {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway:
		_ = conn.Close(status, "")
	case websocket.StatusNoStatusRcvd:
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}

func isExpectedWebSocketClose(err error) bool {
	if err == nil {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusNoStatusRcvd:
		return true
	default:
		return errors.Is(err, context.Canceled)
	}
}

func hasWebSocketProtocol(header, protocol string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), protocol) {
			return true
		}
	}
	return false
}

func cdpTargetRawQuery(source *url.URL) string {
	if _, ok := source.Query()["token"]; !ok {
		return source.RawQuery
	}
	values := source.Query()
	values.Del("token")
	return values.Encode()
}

func browserWebSocketURL(ctx context.Context, port int) (*url.URL, error) {
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
		Path:   "/json/version",
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Host = target.Host

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("cdp version request failed: %s", resp.Status)
	}

	var payload struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	if payload.WebSocketDebuggerURL == "" {
		return nil, fmt.Errorf("cdp version response has no browser websocket url")
	}

	parsed, err := url.Parse(payload.WebSocketDebuggerURL)
	if err != nil {
		return nil, err
	}
	return parsed, nil
}

func rewriteCDPDiscoveryResponse(resp *http.Response, c *gin.Context, sessionID, rawToken string) error {
	if !isCDPDiscoveryPath(resp.Request.URL.Path) {
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

	rewriteCDPDiscoveryValue(payload, c, sessionID, rawToken)

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

func isCDPDiscoveryPath(path string) bool {
	switch path {
	case "/json", "/json/list", "/json/version", "/json/new":
		return true
	default:
		return strings.HasPrefix(path, "/json/new?")
	}
}

func rewriteCDPDiscoveryValue(value any, c *gin.Context, sessionID, rawToken string) {
	switch typed := value.(type) {
	case map[string]any:
		if rawURL, ok := typed["webSocketDebuggerUrl"].(string); ok {
			typed["webSocketDebuggerUrl"] = publicCDPWebSocketURL(c, sessionID, rawURL, rawToken)
		}
		for _, child := range typed {
			rewriteCDPDiscoveryValue(child, c, sessionID, rawToken)
		}
	case []any:
		for _, child := range typed {
			rewriteCDPDiscoveryValue(child, c, sessionID, rawToken)
		}
	}
}

func publicCDPWebSocketURL(c *gin.Context, sessionID, rawTargetURL, rawToken string) string {
	target, err := url.Parse(rawTargetURL)
	if err != nil {
		return rawTargetURL
	}

	targetPath := strings.TrimLeft(target.Path, "/")
	publicPath := strings.TrimRight(cdpBasePathFromContext(c), "/") + "/" + url.PathEscape(sessionID)
	if targetPath != "" {
		publicPath += "/" + targetPath
	}

	values := target.Query()
	if rawToken != "" {
		values.Set("token", rawToken)
	}

	publicURL := url.URL{
		Scheme:   publicWebSocketScheme(c),
		Host:     publicHost(c),
		Path:     publicPath,
		RawQuery: values.Encode(),
	}
	return publicURL.String()
}

func cdpBasePathFromContext(c *gin.Context) string {
	value, ok := c.Get(cdpBasePathContextKey)
	if !ok {
		return "/cdp"
	}
	base, ok := value.(string)
	if !ok || base == "" {
		return "/cdp"
	}
	return base
}

func publicWebSocketScheme(c *gin.Context) string {
	proto := forwardedProto(c)
	if proto == "https" || proto == "wss" || c.Request.TLS != nil {
		return "wss"
	}

	if !isLocalOrSingleLabelHost(publicHost(c)) {
		return "wss"
	}
	return "ws"
}

func publicHost(c *gin.Context) string {
	host := firstForwardedValue(c.GetHeader("X-Forwarded-Host"))
	if host != "" {
		return host
	}
	return c.Request.Host
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

func forwardedProto(c *gin.Context) string {
	for _, header := range []string{
		c.GetHeader("X-Forwarded-Proto"),
		c.GetHeader("X-Forwarded-Protocol"),
		c.GetHeader("X-Url-Scheme"),
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

	if strings.EqualFold(strings.TrimSpace(c.GetHeader("X-Forwarded-Ssl")), "on") {
		return "https"
	}

	for _, field := range strings.Split(c.GetHeader("Forwarded"), ";") {
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
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "" || host == "localhost" || !strings.Contains(host, ".") {
		return true
	}

	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func rawCDPTokenFromCredential(credential string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(credential, prefix) {
		return ""
	}
	return strings.TrimSpace(credential[len(prefix):])
}
