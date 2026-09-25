package browser

import (
	"net/http"
	"strings"

	"github.com/coder/websocket"

	"github.com/aperture/aperture/internal/proxy"
)

// handleLocalTunnel attaches a client's WebSocket as the session's local
// tunnel. The client names the hosts it serves with repeated route query
// parameters; browser connections to them are tunneled to the client for as
// long as the WebSocket stays open.
func (r *wrapperRuntime) handleLocalTunnel(w http.ResponseWriter, req *http.Request) {
	if strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role")) != "owner" {
		writeWrapperError(w, http.StatusForbidden, "local tunnel requires session owner access")
		return
	}
	manager := r.currentProxyManager()
	if manager == nil {
		writeWrapperError(w, http.StatusServiceUnavailable, "session proxy is not running")
		return
	}
	routes, err := proxy.ParseLocalTunnelRoutes(req.URL.Query()["route"])
	if err != nil {
		writeWrapperError(w, http.StatusBadRequest, err.Error())
		return
	}

	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		Subprotocols: []string{proxy.LocalTunnelSubprotocol},
	})
	if err != nil {
		return
	}
	local, err := proxy.NewLocalTunnel(conn, routes)
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "start local tunnel")
		return
	}
	manager.AttachLocalTunnel(local)
	defer manager.DetachLocalTunnel(local)

	// The hijacked connection outlives the request context, so the tunnel
	// itself marks the end: the client disconnects, a newer client replaces
	// it, or the session proxy shuts down.
	<-local.Done()
}
