package browser

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	liveSessionProtocol           = "aperture-session.v1"
	liveSessionMaximumMessageSize = 1024 * 1024
	liveSessionRecoveryWindow     = 5 * time.Second
)

func (session *liveSession) serveSessionWebSocketHTTP(w http.ResponseWriter, req *http.Request) {
	role := strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role"))
	if role != "owner" && role != "editor" && role != "viewer" {
		writeWrapperError(w, http.StatusForbidden, "live session role is unavailable")
		return
	}
	connection, err := websocket.Accept(w, req, &websocket.AcceptOptions{Subprotocols: []string{liveSessionProtocol}})
	if err != nil {
		return
	}
	if connection.Subprotocol() != liveSessionProtocol {
		_ = connection.Close(websocket.StatusPolicyViolation, "live session subprotocol is required")
		return
	}
	connection.SetReadLimit(liveSessionMaximumMessageSize)
	transport := &liveSessionWebSocketTransport{connection: connection, session: session}
	defer transport.close("session transport closed")

	helloCtx, cancelHello := context.WithTimeout(req.Context(), liveSessionHelloTimeout)
	hello, err := readLiveSessionMessage(helloCtx, connection)
	cancelHello()
	if err != nil || hello.Version != 1 || hello.Type != "session.hello" {
		_ = connection.Close(websocket.StatusPolicyViolation, "valid session hello required")
		return
	}

	client, err := session.attachWebSocketClient(req, role, hello, transport)
	if err != nil {
		if errors.Is(err, errLiveSessionResumeRejected) {
			writeLiveSessionTransportError(transport, "resume_rejected", err.Error())
		}
		_ = connection.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	defer session.detachClientTransport(client, transport)

	for {
		message, err := readLiveSessionMessage(req.Context(), connection)
		if err != nil {
			return
		}
		delivery := liveSessionDeliveryReliable
		if message.RealtimeCounter > 0 {
			delivery = liveSessionDeliveryRealtime
		}
		session.handleSessionMessage(client, transport, message, delivery)
	}
}

func (session *liveSession) attachWebSocketClient(req *http.Request, role string, hello liveSessionClientMessage, transport *liveSessionWebSocketTransport) (*liveSessionClient, error) {
	capabilityRole := collaborationCapabilityRole(req)
	generationRole := sessionCapabilityRole(req)
	generation := sessionCapabilityGeneration(req)
	if !session.runtime.sessionAccessGenerationAllowed(generationRole, generation) {
		return nil, errors.New("session access capability is stale")
	}
	if hello.ClientID == "" && hello.ResumeSecret == "" {
		name := strings.TrimSpace(hello.Name)
		if !validLiveSessionName(name) || !validLiveSessionAvatarHash(hello.AvatarHash) {
			return nil, errors.New("session identity is invalid")
		}
		secret, err := newLiveSessionResumeSecret()
		if err != nil {
			return nil, err
		}
		client, err := session.addClient(
			uuid.NewString(),
			role,
			name,
			hello.AvatarHash,
			capabilityRole,
			sessionTokenAuthenticated(req),
		)
		if err != nil {
			return nil, err
		}
		client.resumeSecret = secret
		if err := session.activateTransport(client, transport, nil); err != nil {
			session.removeClient(client)
			return nil, err
		}
		if !session.runtime.sessionAccessGenerationAllowed(generationRole, generation) {
			session.removeClient(client)
			return nil, errors.New("session access capability is stale")
		}
		return client, nil
	}
	if !validLiveSessionClientID(hello.ClientID) || hello.ResumeSecret == "" {
		return nil, errLiveSessionResumeRejected
	}

	session.mu.Lock()
	client := session.clients[hello.ClientID]
	if client == nil || client.resumeSecret != hello.ResumeSecret || client.role != role {
		session.mu.Unlock()
		return nil, errLiveSessionResumeRejected
	}
	client.capabilityRole = capabilityRole
	client.sessionTokenAuthenticated = sessionTokenAuthenticated(req)
	session.mu.Unlock()
	client.transportMu.RLock()
	previous := client.activeTransport
	client.transportMu.RUnlock()
	if err := session.activateTransport(client, transport, previous); err != nil {
		return nil, err
	}
	if !session.runtime.sessionAccessGenerationAllowed(generationRole, generation) {
		session.removeClient(client)
		return nil, errors.New("session access capability is stale")
	}
	return client, nil
}

func (session *liveSession) activateTransport(client *liveSessionClient, transport liveSessionTransport, previous liveSessionTransport) error {
	client.handoverMu.Lock()
	err := session.activateTransportLocked(client, transport, previous)
	client.handoverMu.Unlock()
	if err != nil {
		return err
	}
	if previous != nil && previous != transport {
		previous.close("session transport replaced")
	}
	session.broadcastPresence()
	return nil
}

func (session *liveSession) activateTransportLocked(client *liveSessionClient, transport liveSessionTransport, previous liveSessionTransport) error {
	if client.transport() != previous {
		return errors.New("session transport changed during handover")
	}
	if previous != nil && !session.transportHandoverReady(client) {
		return errors.New("session transport handover requires idle input and painting")
	}
	snapshot, err := session.snapshot(client, transport.kind())
	if err != nil {
		return err
	}
	if snapshot.ActiveTargetID != "" {
		if err := transport.selectTarget(snapshot.ActiveTargetID); err != nil {
			return err
		}
	}
	if err := transport.send(liveSessionDeliveryReliable, mustJSON(snapshot)); err != nil {
		return err
	}
	client.transportMu.Lock()
	client.activeTransport = transport
	client.transportMu.Unlock()
	session.mu.Lock()
	client.recovering = false
	client.realtimeCounter = 0
	client.outboundRealtimeCounter.Store(0)
	if session.holder == client && session.leaseMode == liveSessionLeaseExplicit {
		session.lastSeen = time.Now()
	}
	if client.recoveryTimer != nil {
		client.recoveryTimer.Stop()
		client.recoveryTimer = nil
	}
	session.mu.Unlock()
	return nil
}

func (session *liveSession) transportHandoverReady(client *liveSessionClient) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return client.recovering ||
		(len(client.pressedButtons) == 0 && len(client.pressedKeys) == 0 && client.activePaintStroke == "")
}

func (session *liveSession) detachClientTransport(client *liveSessionClient, transport liveSessionTransport) {
	client.handoverMu.Lock()
	defer client.handoverMu.Unlock()
	client.transportMu.Lock()
	if client.activeTransport != transport {
		client.transportMu.Unlock()
		return
	}
	client.activeTransport = nil
	client.transportMu.Unlock()

	session.mu.Lock()
	if session.clients[client.id] != client {
		session.mu.Unlock()
		return
	}
	client.recovering = true
	client.recoveryGeneration++
	recoveryGeneration := client.recoveryGeneration
	client.activePaintStroke = ""
	client.activePaintTarget = ""
	explicitLease := session.holder == client && session.leaseMode == liveSessionLeaseExplicit
	if explicitLease {
		session.lastSeen = time.Now()
	}
	client.recoveryTimer = time.AfterFunc(liveSessionRecoveryWindow, func() {
		session.expireRecoveringClient(client, recoveryGeneration)
	})
	session.mu.Unlock()
	if !explicitLease && session.clientHoldsInput(client) {
		_ = session.release(client)
		return
	}
	if explicitLease {
		session.inputMu.Lock()
		_ = session.input.release(client.ownerID)
		session.inputMu.Unlock()
		session.mu.Lock()
		clear(client.pressedButtons)
		clear(client.pressedKeys)
		session.mu.Unlock()
	}
	session.broadcastPresence()
}

func (session *liveSession) expireRecoveringClient(client *liveSessionClient, generation uint64) {
	session.mu.Lock()
	expired := session.clients[client.id] == client && client.recovering && client.recoveryGeneration == generation
	session.mu.Unlock()
	if expired {
		session.removeClient(client)
	}
}

func (session *liveSession) snapshot(client *liveSessionClient, transportKind string) (liveSessionServerMessage, error) {
	targets, err := session.browser.targets()
	if err != nil {
		return liveSessionServerMessage{}, err
	}
	var recordings []wrapperRecording
	if client.role == "owner" {
		recordings = session.listRecordings()
	}
	var presentation *liveSessionPresentation
	if mediaProducer := session.runtime.currentMediaProducer(); mediaProducer != nil {
		current := mediaProducer.presentation()
		presentation = &current
	}
	session.mu.Lock()
	if client.activeTargetID == "" {
		client.activeTargetID = session.browser.firstSelectableTargetID(targets)
	}
	participants := session.participantsLocked()
	holderClientID := ""
	if session.holder != nil {
		holderClientID = session.holder.actorID()
	}
	message := liveSessionServerMessage{
		Version:        1,
		Type:           "session.snapshot",
		ClientID:       client.id,
		ResumeSecret:   client.resumeSecret,
		Role:           client.role,
		Transport:      transportKind,
		HolderClientID: holderClientID,
		Mode:           session.leaseMode,
		ActiveTargetID: client.activeTargetID,
		Targets:        targets,
		Participants:   participants,
		Recordings:     recordings,
		Presentation:   presentation,
	}
	session.mu.Unlock()
	return message, nil
}

func readLiveSessionMessage(ctx context.Context, connection *websocket.Conn) (liveSessionClientMessage, error) {
	messageType, body, err := connection.Read(ctx)
	if err != nil {
		return liveSessionClientMessage{}, err
	}
	if messageType != websocket.MessageText {
		return liveSessionClientMessage{}, errors.New("live session messages must be text")
	}
	return decodeLiveSessionMessage(body)
}

func decodeLiveSessionMessage(body []byte) (liveSessionClientMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var message liveSessionClientMessage
	if err := decoder.Decode(&message); err != nil {
		return liveSessionClientMessage{}, errors.New("live session message is invalid")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return liveSessionClientMessage{}, errors.New("live session message is invalid")
	}
	return message, nil
}

func newLiveSessionResumeSecret() (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(secret), nil
}
