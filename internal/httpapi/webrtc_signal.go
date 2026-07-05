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
	errSignalUpgradeRequired  = validationError("websocket upgrade is required")
	errSignalPeerExists       = errors.New("webrtc signal peer already connected")
	errSignalMessageInvalid   = errors.New("invalid webrtc signal message")
	errSignalPeerBackpressure = errors.New("webrtc signal peer backpressure")
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
	role signalRole
	send chan []byte
}

type signalRoom struct {
	producer *signalPeer
	viewer   *signalPeer
}

type SignalCoordinator struct {
	mu    sync.Mutex
	rooms map[string]*signalRoom
}

func NewSignalCoordinator() *SignalCoordinator {
	return &SignalCoordinator{rooms: make(map[string]*signalRoom)}
}

func (s *SignalCoordinator) join(sessionID string, role signalRole) (*signalPeer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	room := s.rooms[sessionID]
	if room == nil {
		room = &signalRoom{}
		s.rooms[sessionID] = room
	}

	peer := &signalPeer{role: role, send: make(chan []byte, 16)}
	switch role {
	case signalRoleProducer:
		if room.producer != nil {
			return nil, errSignalPeerExists
		}
		room.producer = peer
	case signalRoleViewer:
		if room.viewer != nil {
			return nil, errSignalPeerExists
		}
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
	if room == nil {
		return
	}
	if room.producer == peer {
		room.producer = nil
	}
	if room.viewer == peer {
		room.viewer = nil
	}
	close(peer.send)
	if room.producer == nil && room.viewer == nil {
		delete(s.rooms, sessionID)
	}
}

func (s *SignalCoordinator) relay(sessionID string, from *signalPeer, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	room := s.rooms[sessionID]
	var target *signalPeer
	if room != nil {
		if from.role == signalRoleProducer {
			target = room.viewer
		} else {
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

func (s *Server) signalWebRTC(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}
	if !isWebSocketUpgrade(c.Request) {
		WriteError(c, errSignalUpgradeRequired)
		return
	}

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

	sessionID := c.Param("sessionId")
	peer, err := s.Signaling.join(sessionID, role)
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
		if messageType != websocket.MessageText || !validSignalMessage(body) {
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

func validSignalMessage(body []byte) bool {
	var msg signalMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return false
	}
	switch msg.Type {
	case "sdp-offer", "sdp-answer", "ice-candidate", "producer-health", "viewport-metadata", "viewer-ready":
		if len(msg.Payload) == 0 {
			return false
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return false
		}
		return payload != nil
	default:
		return false
	}
}
