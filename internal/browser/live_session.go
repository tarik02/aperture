package browser

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	remoteinput "github.com/tarik02/webdesktop/input"
)

const (
	collaborationProtocol           = "aperture-collaboration.v1"
	collaborationMaximumClients     = 20
	collaborationMaximumMessageSize = 4 * 1024 * 1024
	collaborationHelloTimeout       = 5 * time.Second
	liveSessionLeaseTimeout         = 5 * time.Second
	collaborationWriteTimeout       = 5 * time.Second
	collaborationPaintClientRate    = 50
	collaborationPaintClientBurst   = 20
	liveSessionPaintRate            = 100
	collaborationPaintQueueSize     = 64
	liveSessionPaintBurst           = collaborationPaintQueueSize
)

type liveSessionLeaseMode string

const (
	liveSessionLeaseImplicit liveSessionLeaseMode = "implicit"
	liveSessionLeaseExplicit liveSessionLeaseMode = "explicit"
)

type liveSessionInput interface {
	bind(ownerID uint64, targetID string, onRevoke func()) error
	hasTarget(targetID string) (bool, error)
	submit(ownerID uint64, message collaborationClientMessage) error
	release(ownerID uint64) error
	close() error
}

type liveSessionActor interface {
	actorID() string
	actorRole() string
	actorOwnerID() uint64
	actorName() string
}

type liveSession struct {
	runtime *wrapperRuntime
	input   liveSessionInput

	mu               sync.Mutex
	inputMu          sync.Mutex
	leaseUpdatesMu   sync.Mutex
	presenceMu       sync.Mutex
	clients          map[string]*liveSessionClient
	holder           liveSessionActor
	leaseMode        liveSessionLeaseMode
	lastSeen         time.Time
	nextOwner        uint64
	closed           bool
	paintTokens      float64
	paintTokensAt    time.Time
	recordings       map[string]*wrapperRecording
	recordingClients map[string]*wrapperRecordingClient
}

type liveSessionClient struct {
	id                        string
	role                      string
	ownerID                   uint64
	socket                    *websocket.Conn
	writeMu                   sync.Mutex
	leaseUpdates              chan collaborationServerMessage
	presenceUpdates           chan collaborationServerMessage
	cursorUpdates             chan collaborationServerMessage
	paintUpdates              chan collaborationServerMessage
	sequence                  uint64
	name                      string
	avatarHash                string
	activeTargetID            string
	followingClientID         string
	paintTokens               float64
	paintTokensAt             time.Time
	activePaintStroke         string
	activePaintTarget         string
	capabilityRole            string
	sessionTokenAuthenticated bool
}

type liveSessionAutomation struct {
	id      string
	name    string
	ownerID uint64
}

func (client *liveSessionClient) actorID() string      { return client.id }
func (client *liveSessionClient) actorRole() string    { return client.role }
func (client *liveSessionClient) actorOwnerID() uint64 { return client.ownerID }
func (client *liveSessionClient) actorName() string    { return client.name }

func (automation *liveSessionAutomation) actorID() string      { return automation.id }
func (automation *liveSessionAutomation) actorRole() string    { return "automation" }
func (automation *liveSessionAutomation) actorOwnerID() uint64 { return automation.ownerID }
func (automation *liveSessionAutomation) actorName() string    { return automation.name }

type collaborationClientMessage struct {
	Version               int                  `json:"version"`
	Type                  string               `json:"type"`
	ClientID              string               `json:"clientId"`
	TargetID              string               `json:"targetId"`
	Mode                  liveSessionLeaseMode `json:"mode"`
	Sequence              uint64               `json:"sequence"`
	X                     float64              `json:"x"`
	Y                     float64              `json:"y"`
	ButtonCode            uint32               `json:"buttonCode"`
	Keycode               uint32               `json:"keycode"`
	Text                  string               `json:"text"`
	Key                   string               `json:"key"`
	Code                  string               `json:"code"`
	UnmodifiedText        string               `json:"unmodifiedText"`
	Pressed               bool                 `json:"pressed"`
	Width                 float64              `json:"width"`
	Height                float64              `json:"height"`
	ClickCount            int                  `json:"clickCount"`
	Modifiers             int                  `json:"modifiers"`
	WindowsVirtualKeyCode int                  `json:"windowsVirtualKeyCode"`
	NativeVirtualKeyCode  int                  `json:"nativeVirtualKeyCode"`
	Location              int                  `json:"location"`
	AutoRepeat            bool                 `json:"autoRepeat"`
	IsKeypad              bool                 `json:"isKeypad"`
	Horizontal            float64              `json:"horizontal"`
	Vertical              float64              `json:"vertical"`
	StopHorizontal        bool                 `json:"stopHorizontal"`
	StopVertical          bool                 `json:"stopVertical"`
	Name                  string               `json:"name"`
	AvatarHash            string               `json:"avatarHash"`
	FollowingClientID     string               `json:"followingClientId"`
	StrokeID              string               `json:"strokeId"`
	Color                 string               `json:"color"`
	Phase                 string               `json:"phase"`
}

type collaborationParticipant struct {
	ClientID          string               `json:"clientId"`
	Name              string               `json:"name"`
	AvatarHash        string               `json:"avatarHash"`
	Role              string               `json:"role"`
	ActiveTargetID    string               `json:"activeTargetId,omitempty"`
	FollowingClientID string               `json:"followingClientId,omitempty"`
	HoldingInput      bool                 `json:"holdingInput"`
	LeaseMode         liveSessionLeaseMode `json:"leaseMode,omitempty"`
}

type collaborationServerMessage struct {
	Version        int                        `json:"version"`
	Type           string                     `json:"type"`
	ClientID       string                     `json:"clientId,omitempty"`
	Role           string                     `json:"role,omitempty"`
	HolderClientID string                     `json:"holderClientId,omitempty"`
	Mode           liveSessionLeaseMode       `json:"mode,omitempty"`
	Code           string                     `json:"code,omitempty"`
	Message        string                     `json:"message,omitempty"`
	TargetID       string                     `json:"targetId,omitempty"`
	X              float64                    `json:"x,omitempty"`
	Y              float64                    `json:"y,omitempty"`
	Participants   []collaborationParticipant `json:"participants,omitempty"`
	StrokeID       string                     `json:"strokeId,omitempty"`
	Color          string                     `json:"color,omitempty"`
	Width          float64                    `json:"width,omitempty"`
	Phase          string                     `json:"phase,omitempty"`
}

type automationLeaseRequest struct {
	Name string `json:"name"`
}

func newLiveSession(runtime *wrapperRuntime) (*liveSession, error) {
	var input liveSessionInput
	if !multiTargetCompositorEnabled(runtime.values) {
		input = newLiveSessionCDPInput(runtime.values.CDPPort)
	} else {
		compositorInput, err := newLiveSessionCompositorInput(runtime)
		if err != nil {
			return nil, err
		}
		input = compositorInput
	}
	return &liveSession{
		runtime:          runtime,
		input:            input,
		clients:          make(map[string]*liveSessionClient),
		recordings:       make(map[string]*wrapperRecording),
		recordingClients: make(map[string]*wrapperRecordingClient),
	}, nil
}

func (session *liveSession) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			session.close()
			return
		case <-ticker.C:
			session.expireLease()
		}
	}
}

func (session *liveSession) serveCollaborationHTTP(w http.ResponseWriter, req *http.Request) {
	role := strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role"))
	if role != "owner" && role != "editor" && role != "viewer" {
		writeWrapperError(w, http.StatusForbidden, "collaboration role is unavailable")
		return
	}
	socket, err := websocket.Accept(w, req, &websocket.AcceptOptions{Subprotocols: []string{collaborationProtocol}})
	if err != nil {
		return
	}
	defer func() { _ = socket.Close(websocket.StatusNormalClosure, "done") }()
	socket.SetReadLimit(collaborationMaximumMessageSize)

	var hello collaborationClientMessage
	helloCtx, cancelHello := context.WithTimeout(req.Context(), collaborationHelloTimeout)
	err = readCollaborationMessage(helloCtx, socket, &hello)
	cancelHello()
	if err != nil {
		_ = socket.Close(websocket.StatusPolicyViolation, "valid hello required")
		return
	}
	name := strings.TrimSpace(hello.Name)
	if hello.Version != 1 || hello.Type != "hello" || !validCollaborationClientID(hello.ClientID) || !validCollaborationName(name) || !validCollaborationAvatarHash(hello.AvatarHash) {
		_ = socket.Close(websocket.StatusPolicyViolation, "valid hello required")
		return
	}
	client, err := session.addClient(
		hello.ClientID,
		role,
		name,
		hello.AvatarHash,
		collaborationCapabilityRole(req),
		sessionTokenAuthenticated(req),
		socket,
	)
	if err != nil {
		_ = socket.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	defer session.removeClient(client)
	if err := client.write(collaborationServerMessage{Version: 1, Type: "welcome", ClientID: client.id, Role: client.role}); err != nil {
		return
	}
	go client.writeLeaseUpdates(req.Context())
	go client.writePresenceUpdates(req.Context())
	go client.writeCursorUpdates(req.Context())
	go client.writePaintUpdates(req.Context())
	session.sendLeaseState(client)
	session.broadcastPresence()

	for {
		var message collaborationClientMessage
		if err := readCollaborationMessage(req.Context(), socket, &message); err != nil {
			return
		}
		if message.Version != 1 {
			client.writeError("invalid_version", "unsupported collaboration protocol version")
			continue
		}
		if err := session.handleClientMessage(client, message); err != nil {
			client.writeError(collaborationErrorCode(err), err.Error())
		}
	}
}

func (session *liveSession) serveAutomationLeaseHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !session.runtime.authorizeAutomationLease(req) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeWrapperError(w, http.StatusInternalServerError, "streaming response is unavailable")
		return
	}

	req.Body = http.MaxBytesReader(w, req.Body, 4096)
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	var body automationLeaseRequest
	if err := decoder.Decode(&body); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid automation lease request")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeWrapperError(w, http.StatusBadRequest, "invalid automation lease request")
		return
	}

	automation, err := session.acquireAutomation(body.Name)
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, remoteinput.ErrNotReady) {
			status = http.StatusServiceUnavailable
		}
		writeWrapperError(w, status, err.Error())
		return
	}
	defer session.releaseAutomation(automation)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("{\"status\":\"acquired\"}\n")); err != nil {
		return
	}
	flusher.Flush()
	<-req.Context().Done()
}

func collaborationErrorCode(err error) string {
	switch {
	case errors.Is(err, remoteinput.ErrBusy):
		return "input_busy"
	case errors.Is(err, remoteinput.ErrNotOwner):
		return "input_not_owned"
	case errors.Is(err, remoteinput.ErrNotReady):
		return "input_unavailable"
	default:
		return "request_rejected"
	}
}

func readCollaborationMessage(ctx context.Context, socket *websocket.Conn, target *collaborationClientMessage) error {
	_, body, err := socket.Read(ctx)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return errors.New("invalid collaboration message")
	}
	return nil
}

func (session *liveSession) addClient(id, role, name, avatarHash, capabilityRole string, sessionTokenAuthenticated bool, socket *websocket.Conn) (*liveSessionClient, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil, errors.New("collaboration is unavailable")
	}
	if len(session.clients) >= collaborationMaximumClients {
		return nil, errors.New("collaboration client limit reached")
	}
	if _, exists := session.clients[id]; exists {
		return nil, errors.New("collaboration client id is already connected")
	}
	session.nextOwner++
	client := &liveSessionClient{
		id:                        id,
		role:                      role,
		ownerID:                   session.nextOwner,
		socket:                    socket,
		leaseUpdates:              make(chan collaborationServerMessage, 1),
		presenceUpdates:           make(chan collaborationServerMessage, 1),
		cursorUpdates:             make(chan collaborationServerMessage, 1),
		paintUpdates:              make(chan collaborationServerMessage, collaborationPaintQueueSize),
		name:                      name,
		avatarHash:                avatarHash,
		capabilityRole:            capabilityRole,
		sessionTokenAuthenticated: sessionTokenAuthenticated,
	}
	session.clients[id] = client
	return client, nil
}

func (session *liveSession) removeClient(client *liveSessionClient) {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.clients[client.id] != client {
		session.mu.Unlock()
		return
	}
	delete(session.clients, client.id)
	for _, participant := range session.clients {
		if participant.followingClientID == client.id {
			participant.followingClientID = ""
		}
	}
	holder := session.holder == client
	if holder {
		session.holder = nil
		session.leaseMode = ""
	}
	session.mu.Unlock()
	if holder {
		_ = session.input.release(client.ownerID)
		session.broadcastLeaseState()
	} else {
		session.broadcastPresence()
	}
}

func (session *liveSession) handleClientMessage(client *liveSessionClient, message collaborationClientMessage) error {
	switch message.Type {
	case "input.claim":
		mode := message.Mode
		if mode != liveSessionLeaseImplicit && mode != liveSessionLeaseExplicit {
			return errors.New("invalid input lease mode")
		}
		return session.claim(client, message.TargetID, mode)
	case "input.release":
		return session.release(client)
	case "input.heartbeat":
		return session.heartbeat(client)
	case "input.pointer.motion.absolute", "input.pointer.button", "input.pointer.scroll", "input.keyboard.key", "input.keyboard.text":
		return session.submit(client, message)
	case "presence.active-target":
		return session.updateActiveTarget(client, message.TargetID)
	case "presence.cursor":
		return session.updateCursor(client, message.TargetID, message.X, message.Y)
	case "presence.cursor.clear":
		session.clearCursor(client)
		return nil
	case "follow.set":
		return session.setFollowing(client, message.FollowingClientID)
	case "paint.point":
		return session.paintPoint(client, message)
	default:
		return errors.New("unknown collaboration message type")
	}
}

func (session *liveSession) paintPoint(client *liveSessionClient, message collaborationClientMessage) error {
	if message.TargetID == "" {
		return errors.New("paint target is unavailable")
	}
	if !validPaintStrokeID(message.StrokeID) || !validPaintColor(message.Color) || message.Width < 1 || message.Width > 16 {
		return errors.New("paint stroke is invalid")
	}
	if message.Phase != "start" && message.Phase != "move" && message.Phase != "end" {
		return errors.New("paint phase is invalid")
	}
	if message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
		return errors.New("paint point is invalid")
	}
	session.mu.Lock()
	now := time.Now()
	if message.Phase == "start" && client.activeTargetID != message.TargetID {
		session.mu.Unlock()
		return errors.New("paint target is unavailable")
	}
	if message.Phase != "start" && (client.activePaintStroke != message.StrokeID || client.activePaintTarget != message.TargetID) {
		session.mu.Unlock()
		return nil
	}
	if message.Phase == "end" {
		client.activePaintStroke = ""
		client.activePaintTarget = ""
	} else {
		if client.paintTokensAt.IsZero() {
			client.paintTokens = collaborationPaintClientBurst
		} else {
			client.paintTokens += now.Sub(client.paintTokensAt).Seconds() * collaborationPaintClientRate
			if client.paintTokens > collaborationPaintClientBurst {
				client.paintTokens = collaborationPaintClientBurst
			}
		}
		client.paintTokensAt = now
		if session.paintTokensAt.IsZero() {
			session.paintTokens = liveSessionPaintBurst
		} else {
			session.paintTokens += now.Sub(session.paintTokensAt).Seconds() * liveSessionPaintRate
			if session.paintTokens > liveSessionPaintBurst {
				session.paintTokens = liveSessionPaintBurst
			}
		}
		session.paintTokensAt = now
		hubTokenCost := 1.0
		if message.Phase == "start" {
			hubTokenCost = 2
		}
		if client.paintTokens < 1 || session.paintTokens < hubTokenCost {
			session.mu.Unlock()
			return nil
		}
		client.paintTokens--
		session.paintTokens -= hubTokenCost
		if message.Phase == "start" {
			client.activePaintStroke = message.StrokeID
			client.activePaintTarget = message.TargetID
		}
	}
	session.mu.Unlock()
	session.broadcastPaint(collaborationServerMessage{
		Version:  1,
		Type:     "paint.point",
		ClientID: client.id,
		TargetID: message.TargetID,
		StrokeID: message.StrokeID,
		Color:    message.Color,
		Width:    message.Width,
		Phase:    message.Phase,
		X:        message.X,
		Y:        message.Y,
	})
	return nil
}

func (session *liveSession) broadcastPaint(message collaborationServerMessage) {
	session.mu.Lock()
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, client)
	}
	session.mu.Unlock()
	for _, client := range clients {
		client.queuePaintUpdate(message)
	}
}

func (session *liveSession) updateActiveTarget(client *liveSessionClient, targetID string) error {
	targetID = strings.TrimSpace(targetID)
	if len(targetID) > 128 {
		return errors.New("active target is invalid")
	}
	if targetID != "" && !session.knownTarget(targetID) {
		return errors.New("active target is unavailable")
	}
	session.mu.Lock()
	client.activeTargetID = targetID
	session.mu.Unlock()
	session.broadcastPresence()
	return nil
}

func (session *liveSession) updateCursor(client *liveSessionClient, targetID string, x, y float64) error {
	if targetID == "" || x < 0 || x > 1 || y < 0 || y > 1 {
		return errors.New("cursor position is invalid")
	}
	message := collaborationServerMessage{Version: 1, Type: "presence.cursor", ClientID: client.id, TargetID: targetID, X: x, Y: y}
	session.mu.Lock()
	if client.activeTargetID != targetID {
		session.mu.Unlock()
		return errors.New("cursor target is unavailable")
	}
	followers := make([]*liveSessionClient, 0)
	for _, participant := range session.clients {
		if participant.followingClientID == client.id {
			followers = append(followers, participant)
		}
	}
	session.mu.Unlock()
	for _, follower := range followers {
		follower.queueCursorUpdate(message)
	}
	return nil
}

func (session *liveSession) clearCursor(client *liveSessionClient) {
	message := collaborationServerMessage{Version: 1, Type: "presence.cursor.clear", ClientID: client.id}
	session.mu.Lock()
	followers := make([]*liveSessionClient, 0)
	for _, participant := range session.clients {
		if participant.followingClientID == client.id {
			followers = append(followers, participant)
		}
	}
	session.mu.Unlock()
	for _, follower := range followers {
		follower.queueCursorUpdate(message)
	}
}

func (client *liveSessionClient) queuePresenceUpdate(message collaborationServerMessage) {
	select {
	case client.presenceUpdates <- message:
		return
	default:
	}
	select {
	case <-client.presenceUpdates:
	default:
	}
	select {
	case client.presenceUpdates <- message:
	default:
	}
}

func (client *liveSessionClient) writePresenceUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.presenceUpdates:
			if client.write(message) != nil {
				_ = client.socket.CloseNow()
				return
			}
		}
	}
}

func (client *liveSessionClient) queueCursorUpdate(message collaborationServerMessage) {
	select {
	case client.cursorUpdates <- message:
		return
	default:
	}
	select {
	case <-client.cursorUpdates:
	default:
	}
	select {
	case client.cursorUpdates <- message:
	default:
	}
}

func (client *liveSessionClient) writeCursorUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.cursorUpdates:
			if client.write(message) != nil {
				_ = client.socket.CloseNow()
				return
			}
		}
	}
}

func (client *liveSessionClient) queuePaintUpdate(message collaborationServerMessage) {
	select {
	case client.paintUpdates <- message:
	default:
		_ = client.socket.CloseNow()
	}
}

func (client *liveSessionClient) writePaintUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.paintUpdates:
			if client.write(message) != nil {
				_ = client.socket.CloseNow()
				return
			}
		}
	}
}

func (session *liveSession) setFollowing(client *liveSessionClient, followingClientID string) error {
	session.mu.Lock()
	if followingClientID == "" {
		client.followingClientID = ""
		session.mu.Unlock()
		session.broadcastPresence()
		return nil
	}
	followed := session.clients[followingClientID]
	if followed == nil {
		session.mu.Unlock()
		return errors.New("followed participant is unavailable")
	}
	for current := followed; current != nil; current = session.clients[current.followingClientID] {
		if current == client {
			session.mu.Unlock()
			return errors.New("follow cycle is not allowed")
		}
		if current.followingClientID == "" {
			break
		}
	}
	client.followingClientID = followingClientID
	session.mu.Unlock()
	session.broadcastPresence()
	return nil
}

func (session *liveSession) claim(client *liveSessionClient, targetID string, mode liveSessionLeaseMode) error {
	if client.role == "viewer" {
		return errors.New("viewer input is disabled")
	}
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.closed || session.clients[client.id] != client {
		session.mu.Unlock()
		return remoteinput.ErrNotReady
	}
	if session.holder == client {
		if session.leaseMode != liveSessionLeaseExplicit {
			session.leaseMode = mode
		}
		session.lastSeen = time.Now()
		session.mu.Unlock()
		if err := session.bindInputTarget(client, targetID); err != nil {
			session.releaseInputAndRevoke(client)
			return err
		}
		if !session.clientHoldsInput(client) {
			_ = session.input.release(client.ownerID)
			return remoteinput.ErrNotReady
		}
		session.broadcastLeaseState()
		return nil
	}
	ownerPreemptsEditor := client.role == "owner" && session.holder != nil && session.holder.actorRole() == "editor"
	canPreempt := mode == liveSessionLeaseExplicit && (session.leaseMode == liveSessionLeaseImplicit || ownerPreemptsEditor)
	if session.holder != nil && session.holder != client && !canPreempt {
		session.mu.Unlock()
		return remoteinput.ErrBusy
	}
	previous := session.holder
	session.holder = client
	session.leaseMode = mode
	session.lastSeen = time.Now()
	session.mu.Unlock()
	if previous != nil {
		_ = session.input.release(previous.actorOwnerID())
	}
	if err := session.bindInputTarget(client, targetID); err != nil {
		session.releaseInputAndRevoke(client)
		return err
	}
	if !session.clientHoldsInput(client) {
		_ = session.input.release(client.ownerID)
		return remoteinput.ErrNotReady
	}
	session.broadcastLeaseState()
	return nil
}

func (session *liveSession) heartbeat(client *liveSessionClient) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.holder != client {
		return remoteinput.ErrNotOwner
	}
	session.lastSeen = time.Now()
	return nil
}

func (session *liveSession) release(client *liveSessionClient) error {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.holder != client {
		session.mu.Unlock()
		return remoteinput.ErrNotOwner
	}
	session.holder = nil
	session.leaseMode = ""
	session.mu.Unlock()
	err := session.input.release(client.ownerID)
	session.broadcastLeaseState()
	return err
}

func (session *liveSession) revoke(client *liveSessionClient) {
	session.mu.Lock()
	if session.holder != client {
		session.mu.Unlock()
		return
	}
	session.holder = nil
	session.leaseMode = ""
	session.mu.Unlock()
	session.broadcastLeaseState()
}

func (session *liveSession) submit(client *liveSessionClient, message collaborationClientMessage) error {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.holder != client {
		session.mu.Unlock()
		return remoteinput.ErrNotOwner
	}
	if message.Sequence <= client.sequence {
		session.mu.Unlock()
		return errors.New("input sequence must increase")
	}
	session.mu.Unlock()
	if err := session.bindInputTarget(client, message.TargetID); err != nil {
		session.releaseInputAndRevoke(client)
		return err
	}
	session.mu.Lock()
	if session.holder != client {
		session.mu.Unlock()
		_ = session.input.release(client.ownerID)
		return remoteinput.ErrNotOwner
	}
	client.sequence = message.Sequence
	session.lastSeen = time.Now()
	session.mu.Unlock()
	if err := session.input.submit(client.ownerID, message); err != nil {
		session.releaseInputAndRevoke(client)
		return err
	}
	return nil
}

func (session *liveSession) bindInputTarget(client *liveSessionClient, targetID string) error {
	return session.input.bind(client.ownerID, targetID, func() {
		session.revoke(client)
	})
}

func (session *liveSession) releaseInputAndRevoke(client *liveSessionClient) {
	_ = session.input.release(client.ownerID)
	session.revoke(client)
}

func (session *liveSession) clientHoldsInput(client *liveSessionClient) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.holder == client
}

func (session *liveSession) knownTarget(targetID string) bool {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	known, err := session.input.hasTarget(targetID)
	return err == nil && known
}

func (session *liveSession) expireLease() {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.holder == nil || time.Since(session.lastSeen) < liveSessionLeaseTimeout {
		session.mu.Unlock()
		return
	}
	if _, interactive := session.holder.(*liveSessionClient); !interactive {
		session.mu.Unlock()
		return
	}
	holder := session.holder
	session.holder = nil
	session.leaseMode = ""
	session.mu.Unlock()
	_ = session.input.release(holder.actorOwnerID())
	session.broadcastLeaseState()
}

func (session *liveSession) sendLeaseState(client *liveSessionClient) {
	session.leaseUpdatesMu.Lock()
	defer session.leaseUpdatesMu.Unlock()
	session.mu.Lock()
	message := session.leaseStateLocked()
	session.mu.Unlock()
	client.queueLeaseUpdate(message)
}

func (session *liveSession) broadcastLeaseState() {
	session.leaseUpdatesMu.Lock()
	defer session.leaseUpdatesMu.Unlock()
	session.mu.Lock()
	message := session.leaseStateLocked()
	session.mu.Unlock()
	session.broadcast(message)
	session.broadcastPresence()
}

func (session *liveSession) broadcastPresence() {
	session.presenceMu.Lock()
	defer session.presenceMu.Unlock()

	session.mu.Lock()
	participants := make([]collaborationParticipant, 0, len(session.clients)+1)
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, client)
		participant := collaborationParticipant{
			ClientID:          client.id,
			Name:              client.name,
			AvatarHash:        client.avatarHash,
			Role:              client.role,
			ActiveTargetID:    client.activeTargetID,
			FollowingClientID: client.followingClientID,
			HoldingInput:      session.holder == client,
		}
		if session.holder == client {
			participant.LeaseMode = session.leaseMode
		}
		participants = append(participants, participant)
	}
	if automation, ok := session.holder.(*liveSessionAutomation); ok {
		participants = append(participants, collaborationParticipant{
			ClientID:     automation.actorID(),
			Name:         automation.actorName(),
			Role:         automation.actorRole(),
			HoldingInput: true,
			LeaseMode:    session.leaseMode,
		})
	}
	session.mu.Unlock()
	sort.Slice(participants, func(left, right int) bool {
		return participants[left].ClientID < participants[right].ClientID
	})
	message := collaborationServerMessage{Version: 1, Type: "presence.state", Participants: participants}
	for _, client := range clients {
		client.queuePresenceUpdate(message)
	}
}

func (session *liveSession) broadcast(message collaborationServerMessage) {
	session.mu.Lock()
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, client)
	}
	session.mu.Unlock()
	for _, client := range clients {
		client.queueLeaseUpdate(message)
	}
}

func (client *liveSessionClient) queueLeaseUpdate(message collaborationServerMessage) {
	select {
	case client.leaseUpdates <- message:
		return
	default:
	}
	select {
	case <-client.leaseUpdates:
	default:
	}
	select {
	case client.leaseUpdates <- message:
	default:
	}
}

func (client *liveSessionClient) writeLeaseUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.leaseUpdates:
			if client.write(message) != nil {
				_ = client.socket.CloseNow()
				return
			}
		}
	}
}

func (session *liveSession) leaseStateLocked() collaborationServerMessage {
	message := collaborationServerMessage{Version: 1, Type: "input.state", Mode: session.leaseMode}
	if session.holder != nil {
		message.HolderClientID = session.holder.actorID()
	}
	return message
}

func (session *liveSession) acquireAutomation(name string) (*liveSessionAutomation, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Session automation"
	}
	if !validCollaborationName(name) {
		return nil, errors.New("automation actor name is invalid")
	}

	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil, remoteinput.ErrNotReady
	}
	if session.holder != nil {
		session.mu.Unlock()
		return nil, remoteinput.ErrBusy
	}
	session.nextOwner++
	automation := &liveSessionAutomation{
		id:      "automation-" + uuid.NewString(),
		name:    name,
		ownerID: session.nextOwner,
	}
	session.holder = automation
	session.leaseMode = liveSessionLeaseExplicit
	session.lastSeen = time.Time{}
	session.mu.Unlock()
	session.broadcastLeaseState()
	return automation, nil
}

func (session *liveSession) releaseAutomation(automation *liveSessionAutomation) {
	session.inputMu.Lock()
	session.mu.Lock()
	if session.holder != automation {
		session.mu.Unlock()
		session.inputMu.Unlock()
		return
	}
	session.holder = nil
	session.leaseMode = ""
	session.mu.Unlock()
	session.inputMu.Unlock()
	session.broadcastLeaseState()
}

func (client *liveSessionClient) write(message collaborationServerMessage) error {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), collaborationWriteTimeout)
	defer cancel()
	return client.socket.Write(ctx, websocket.MessageText, mustJSON(message))
}

func (client *liveSessionClient) writeError(code, message string) {
	_ = client.write(collaborationServerMessage{Version: 1, Type: "error", Code: code, Message: message})
}

func mustJSON(value any) []byte {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return body
}

func (session *liveSession) close() {
	session.inputMu.Lock()
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		session.inputMu.Unlock()
		return
	}
	session.closed = true
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, client)
	}
	session.clients = make(map[string]*liveSessionClient)
	session.holder = nil
	session.mu.Unlock()
	_ = session.input.close()
	session.inputMu.Unlock()
	for _, client := range clients {
		_ = client.socket.Close(websocket.StatusGoingAway, "collaboration stopped")
	}
}

func (session *liveSession) disconnectSessionTokenClients() {
	session.mu.Lock()
	clients := make([]*liveSessionClient, 0)
	for _, client := range session.clients {
		if client.sessionTokenAuthenticated {
			clients = append(clients, client)
		}
	}
	session.mu.Unlock()
	for _, client := range clients {
		_ = client.socket.CloseNow()
	}
}

func (session *liveSession) disconnectCapabilityRoleClients(role string) {
	session.mu.Lock()
	clients := make([]*liveSessionClient, 0)
	for _, client := range session.clients {
		if client.capabilityRole == role {
			clients = append(clients, client)
		}
	}
	session.mu.Unlock()
	for _, client := range clients {
		_ = client.socket.CloseNow()
	}
}

func validCollaborationClientID(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func validCollaborationName(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && utf8.RuneCountInString(value) <= 48
}

func validCollaborationAvatarHash(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return true
}

func validPaintStrokeID(value string) bool {
	return validCollaborationClientID(value)
}

func validPaintColor(value string) bool {
	if len(value) != 7 || value[0] != '#' {
		return false
	}
	for _, character := range value[1:] {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' || character >= 'A' && character <= 'F' {
			continue
		}
		return false
	}
	return true
}
