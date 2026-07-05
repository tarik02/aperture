package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/aperture/aperture/internal/auth"
	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

const (
	webrtcSignalProtocol = "aperture-webrtc.v1"
	webrtcSignalMaxBytes = 64 << 10
)

var (
	errSignalRoleInvalid      = validationError("role must be producer or viewer")
	errSignalProtocolRequired = validationError("websocket protocol aperture-webrtc.v1 is required")
	errSignalUpgradeRequired  = validationError("websocket upgrade is required")
	errSignalMessageInvalid   = errors.New("invalid webrtc signal message")
	errSignalPeerBackpressure = errors.New("webrtc signal peer backpressure")
	errSignalSessionChanged   = errors.New("webrtc signal session lifecycle changed")
)

type signalRole string

const (
	signalRoleProducer signalRole = "producer"
	signalRoleViewer   signalRole = "viewer"
)

type signalMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type signalPeer struct {
	role      signalRole
	send      chan []byte
	closeOnce sync.Once
}

type signalRoom struct {
	producer *signalPeer
	viewer   *signalPeer
}

type SignalCoordinator struct {
	mu          sync.Mutex
	rooms       map[string]*signalRoom
	generations map[string]uint64
}

func NewSignalCoordinator() *SignalCoordinator {
	return &SignalCoordinator{
		rooms:       make(map[string]*signalRoom),
		generations: make(map[string]uint64),
	}
}

func (s *SignalCoordinator) Generation(sessionID string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generations[sessionID]
}

func (s *SignalCoordinator) join(sessionID string, role signalRole, generation uint64) (*signalPeer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.generations[sessionID] != generation {
		return nil, errSignalSessionChanged
	}

	room := s.rooms[sessionID]
	if room == nil {
		room = &signalRoom{}
		s.rooms[sessionID] = room
	}

	peer := &signalPeer{role: role, send: make(chan []byte, 16)}
	switch role {
	case signalRoleProducer:
		closeSignalPeer(room.producer)
		room.producer = peer
	case signalRoleViewer:
		closeSignalPeer(room.viewer)
		room.viewer = peer
	default:
		return nil, errSignalRoleInvalid
	}
	return peer, nil
}

func (s *SignalCoordinator) leave(sessionID string, peer *signalPeer) {
	s.mu.Lock()
	defer s.mu.Unlock()

	room := s.rooms[sessionID]
	if room != nil {
		if room.producer == peer {
			room.producer = nil
		}
		if room.viewer == peer {
			room.viewer = nil
		}
		if room.producer == nil && room.viewer == nil {
			delete(s.rooms, sessionID)
		}
	}
	closeSignalPeer(peer)
}

func (s *SignalCoordinator) relay(sessionID string, from *signalPeer, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	room := s.rooms[sessionID]
	var target *signalPeer
	if room != nil {
		if from.role == signalRoleProducer {
			if room.producer != from {
				return nil
			}
			target = room.viewer
		} else {
			if room.viewer != from {
				return nil
			}
			target = room.producer
		}
	}

	if target == nil {
		return nil
	}
	select {
	case target.send <- body:
		return nil
	default:
		return errSignalPeerBackpressure
	}
}

func (s *SignalCoordinator) CloseSessionMedia(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.generations[sessionID]++
	room := s.rooms[sessionID]
	if room == nil {
		return
	}
	delete(s.rooms, sessionID)
	closeSignalPeer(room.producer)
	closeSignalPeer(room.viewer)
}

func closeSignalPeer(peer *signalPeer) {
	if peer == nil {
		return
	}
	peer.closeOnce.Do(func() {
		close(peer.send)
	})
}

func (s *Server) signalWebRTC(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	if !isWebSocketUpgrade(c.Request) {
		WriteError(c, errSignalUpgradeRequired)
		return
	}
	if !hasWebSocketProtocol(c.GetHeader("Sec-WebSocket-Protocol"), webrtcSignalProtocol) {
		WriteError(c, errSignalProtocolRequired)
		return
	}

	sessionID := c.Param("sessionId")
	generation := s.Signaling.Generation(sessionID)
	role, tenantID, err := s.authorizeSignalPeer(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	_ = tenantID

	conn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		Subprotocols:       []string{webrtcSignalProtocol},
	})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(webrtcSignalMaxBytes)

	if _, _, err := s.authorizeSignalPeer(c); err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}

	peer, err := s.Signaling.join(sessionID, role, generation)
	if err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	defer s.Signaling.leave(sessionID, peer)

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	go func() {
		defer cancel()
		for body := range peer.send {
			if err := conn.Write(ctx, websocket.MessageText, body); err != nil {
				if !isExpectedWebSocketClose(err) {
					_ = conn.Close(websocket.StatusInternalError, err.Error())
				}
				return
			}
		}
	}()

	for {
		messageType, body, err := conn.Read(ctx)
		if err != nil {
			if !isExpectedWebSocketClose(err) {
				_ = conn.Close(websocket.StatusInternalError, err.Error())
			}
			return
		}
		if messageType != websocket.MessageText || !validSignalMessage(peer.role, body) {
			_ = conn.Close(websocket.StatusUnsupportedData, errSignalMessageInvalid.Error())
			return
		}
		if err := s.Signaling.relay(sessionID, peer, body); err != nil {
			_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
			return
		}
	}
}

func (s *Server) authorizeSignalPeer(c *gin.Context) (signalRole, string, error) {
	switch signalRole(c.Query("role")) {
	case signalRoleViewer:
		principal, err := s.authenticate(c)
		if err != nil {
			return "", "", err
		}
		if !auth.HasScope(principal.Scopes, auth.ScopeSessionsWrite) {
			return "", "", auth.ErrScopeDenied
		}
		tenantID, err := auth.ResolveTenantID(principal, selectedTenantID(c))
		if err != nil {
			return "", "", err
		}
		if _, err := s.Sessions.RunningCDPPort(c.Request.Context(), tenantID, c.Param("sessionId")); err != nil {
			return "", "", err
		}
		return signalRoleViewer, tenantID, nil
	case signalRoleProducer:
		rawToken, err := rawTokenFromRequest(c)
		if err != nil {
			return "", "", err
		}
		sessionRow, err := s.Sessions.ValidateMediaProducerSignalAuth(c.Request.Context(), c.Param("sessionId"), rawToken)
		if err != nil {
			return "", "", err
		}
		return signalRoleProducer, sessionRow.TenantID, nil
	default:
		return "", "", errSignalRoleInvalid
	}
}

func validSignalMessage(role signalRole, body []byte) bool {
	var msg signalMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return false
	}
	if !validSignalMessageType(role, msg.Type) {
		return false
	}
	if len(msg.Payload) == 0 {
		return false
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return false
	}
	if payload == nil {
		return false
	}
	switch msg.Type {
	case "producer-health":
		return validProducerHealthPayload(payload)
	case "viewport-metadata":
		return validViewportMetadataPayload(payload)
	default:
		return true
	}
}

func validSignalMessageType(role signalRole, messageType string) bool {
	switch role {
	case signalRoleProducer:
		switch messageType {
		case "sdp-offer", "ice-candidate", "producer-health", "viewport-metadata":
			return true
		}
	case signalRoleViewer:
		switch messageType {
		case "sdp-answer", "ice-candidate", "viewer-ready":
			return true
		}
	}
	return false
}

func validProducerHealthPayload(payload map[string]json.RawMessage) bool {
	for key := range payload {
		if key != "status" && key != "code" {
			return false
		}
	}
	var status string
	if err := json.Unmarshal(payload["status"], &status); err != nil {
		return false
	}
	switch status {
	case "idle", "starting", "streaming", "negotiating", "connected":
		return len(payload) == 1
	case "failed":
		if codeRaw, ok := payload["code"]; ok {
			var code string
			return json.Unmarshal(codeRaw, &code) == nil && code != ""
		}
		return true
	default:
		return false
	}
}

func validViewportMetadataPayload(payload map[string]json.RawMessage) bool {
	for key := range payload {
		if key != "width" && key != "height" {
			return false
		}
	}
	var width int
	var height int
	if err := json.Unmarshal(payload["width"], &width); err != nil {
		return false
	}
	if err := json.Unmarshal(payload["height"], &height); err != nil {
		return false
	}
	return width > 0 && height > 0
}
