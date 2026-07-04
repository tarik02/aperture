package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
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
		if err := proxyCDPWebSocket(c.Request.Context(), c.Writer, req, target); err != nil {
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

func proxyCDPWebSocket(ctx context.Context, w http.ResponseWriter, req *http.Request, target *url.URL) error {
	targetURL := *target
	targetURL.Scheme = "ws"

	backend, _, err := websocket.Dial(ctx, targetURL.String(), &websocket.DialOptions{
		HTTPHeader: cloneCDPProxyHeaders(req.Header),
	})
	if err != nil {
		return err
	}
	defer backend.Close(websocket.StatusInternalError, "proxy closed")

	client, err := websocket.Accept(w, req, nil)
	if err != nil {
		return err
	}
	defer client.Close(websocket.StatusInternalError, "proxy closed")

	backend.SetReadLimit(-1)
	client.SetReadLimit(-1)

	errc := make(chan error, 2)
	go func() {
		errc <- copyCDPWebSocket(ctx, client, backend)
	}()
	go func() {
		errc <- copyCDPWebSocket(ctx, backend, client)
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errc:
		return err
	}
}

func copyCDPWebSocket(ctx context.Context, dst, src *websocket.Conn) error {
	for {
		typ, msg, err := src.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure || err == io.EOF {
				return nil
			}
			return err
		}
		if err := dst.Write(ctx, typ, msg); err != nil {
			return err
		}
	}
}

func cloneCDPProxyHeaders(hdr http.Header) http.Header {
	cloned := make(http.Header, len(hdr))
	for key, values := range hdr {
		if strings.EqualFold(key, "Authorization") || strings.EqualFold(key, auth.TenantHeader) {
			continue
		}
		cloned[key] = append([]string(nil), values...)
	}
	return cloned
}
