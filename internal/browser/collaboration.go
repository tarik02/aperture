package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	remoteinput "github.com/tarik02/webdesktop/input"
)

const (
	collaborationProtocol           = "aperture-collaboration.v1"
	collaborationMaximumClients     = 20
	collaborationMaximumMessageSize = 4 * 1024 * 1024
	collaborationHelloTimeout       = 5 * time.Second
	collaborationLeaseTimeout       = 5 * time.Second
	collaborationWriteTimeout       = 5 * time.Second
	collaborationPaintClientRate    = 50
	collaborationPaintClientBurst   = 20
	collaborationPaintHubRate       = 100
	collaborationPaintQueueSize     = 64
	collaborationPaintHubBurst      = collaborationPaintQueueSize
)

type collaborationLeaseMode string

const (
	collaborationLeaseImplicit collaborationLeaseMode = "implicit"
	collaborationLeaseExplicit collaborationLeaseMode = "explicit"
)

type collaborationInput interface {
	bind(ownerID uint64, targetID string, onRevoke func()) error
	hasTarget(targetID string) (bool, error)
	submit(ownerID uint64, message collaborationClientMessage) error
	release(ownerID uint64) error
	close() error
}

type collaborationHub struct {
	input collaborationInput

	mu             sync.Mutex
	inputMu        sync.Mutex
	leaseUpdatesMu sync.Mutex
	presenceMu     sync.Mutex
	clients        map[string]*collaborationClient
	holder         *collaborationClient
	leaseMode      collaborationLeaseMode
	lastSeen       time.Time
	nextOwner      uint64
	closed         bool
	paintTokens    float64
	paintTokensAt  time.Time
}

type collaborationClient struct {
	hub                       *collaborationHub
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
	sessionTokenAuthenticated bool
}

type collaborationClientMessage struct {
	Version               int                    `json:"version"`
	Type                  string                 `json:"type"`
	ClientID              string                 `json:"clientId"`
	TargetID              string                 `json:"targetId"`
	Mode                  collaborationLeaseMode `json:"mode"`
	Sequence              uint64                 `json:"sequence"`
	X                     float64                `json:"x"`
	Y                     float64                `json:"y"`
	ButtonCode            uint32                 `json:"buttonCode"`
	Keycode               uint32                 `json:"keycode"`
	Text                  string                 `json:"text"`
	Key                   string                 `json:"key"`
	Code                  string                 `json:"code"`
	UnmodifiedText        string                 `json:"unmodifiedText"`
	Pressed               bool                   `json:"pressed"`
	Width                 float64                `json:"width"`
	Height                float64                `json:"height"`
	ClickCount            int                    `json:"clickCount"`
	Modifiers             int                    `json:"modifiers"`
	WindowsVirtualKeyCode int                    `json:"windowsVirtualKeyCode"`
	NativeVirtualKeyCode  int                    `json:"nativeVirtualKeyCode"`
	Location              int                    `json:"location"`
	AutoRepeat            bool                   `json:"autoRepeat"`
	IsKeypad              bool                   `json:"isKeypad"`
	Horizontal            float64                `json:"horizontal"`
	Vertical              float64                `json:"vertical"`
	StopHorizontal        bool                   `json:"stopHorizontal"`
	StopVertical          bool                   `json:"stopVertical"`
	Name                  string                 `json:"name"`
	AvatarHash            string                 `json:"avatarHash"`
	FollowingClientID     string                 `json:"followingClientId"`
	StrokeID              string                 `json:"strokeId"`
	Color                 string                 `json:"color"`
	Phase                 string                 `json:"phase"`
}

type collaborationParticipant struct {
	ClientID          string                 `json:"clientId"`
	Name              string                 `json:"name"`
	AvatarHash        string                 `json:"avatarHash"`
	Role              string                 `json:"role"`
	ActiveTargetID    string                 `json:"activeTargetId,omitempty"`
	FollowingClientID string                 `json:"followingClientId,omitempty"`
	HoldingInput      bool                   `json:"holdingInput"`
	LeaseMode         collaborationLeaseMode `json:"leaseMode,omitempty"`
}

type collaborationServerMessage struct {
	Version        int                        `json:"version"`
	Type           string                     `json:"type"`
	ClientID       string                     `json:"clientId,omitempty"`
	Role           string                     `json:"role,omitempty"`
	HolderClientID string                     `json:"holderClientId,omitempty"`
	Mode           collaborationLeaseMode     `json:"mode,omitempty"`
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

func newCollaborationHub(runtime *wrapperRuntime) (*collaborationHub, error) {
	var input collaborationInput
	if !multiTargetCompositorEnabled(runtime.values) {
		input = newCollaborationCDPInput(runtime.values.CDPPort)
	} else {
		compositorInput, err := newCollaborationCompositorInput(runtime)
		if err != nil {
			return nil, err
		}
		input = compositorInput
	}
	return &collaborationHub{
		input:   input,
		clients: make(map[string]*collaborationClient),
	}, nil
}

func (hub *collaborationHub) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			hub.close()
			return
		case <-ticker.C:
			hub.expireLease()
		}
	}
}

func (hub *collaborationHub) serveHTTP(w http.ResponseWriter, req *http.Request) {
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
	client, err := hub.addClient(hello.ClientID, role, name, hello.AvatarHash, sessionTokenAuthenticated(req), socket)
	if err != nil {
		_ = socket.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	defer hub.removeClient(client)
	if err := client.write(collaborationServerMessage{Version: 1, Type: "welcome", ClientID: client.id, Role: client.role}); err != nil {
		return
	}
	go client.writeLeaseUpdates(req.Context())
	go client.writePresenceUpdates(req.Context())
	go client.writeCursorUpdates(req.Context())
	go client.writePaintUpdates(req.Context())
	hub.sendLeaseState(client)
	hub.broadcastPresence()

	for {
		var message collaborationClientMessage
		if err := readCollaborationMessage(req.Context(), socket, &message); err != nil {
			return
		}
		if message.Version != 1 {
			client.writeError("invalid_version", "unsupported collaboration protocol version")
			continue
		}
		if err := hub.handleClientMessage(client, message); err != nil {
			client.writeError(collaborationErrorCode(err), err.Error())
		}
	}
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

func (hub *collaborationHub) addClient(id, role, name, avatarHash string, sessionTokenAuthenticated bool, socket *websocket.Conn) (*collaborationClient, error) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return nil, errors.New("collaboration is unavailable")
	}
	if len(hub.clients) >= collaborationMaximumClients {
		return nil, errors.New("collaboration client limit reached")
	}
	if _, exists := hub.clients[id]; exists {
		return nil, errors.New("collaboration client id is already connected")
	}
	hub.nextOwner++
	client := &collaborationClient{
		hub:                       hub,
		id:                        id,
		role:                      role,
		ownerID:                   hub.nextOwner,
		socket:                    socket,
		leaseUpdates:              make(chan collaborationServerMessage, 1),
		presenceUpdates:           make(chan collaborationServerMessage, 1),
		cursorUpdates:             make(chan collaborationServerMessage, 1),
		paintUpdates:              make(chan collaborationServerMessage, collaborationPaintQueueSize),
		name:                      name,
		avatarHash:                avatarHash,
		sessionTokenAuthenticated: sessionTokenAuthenticated,
	}
	hub.clients[id] = client
	return client, nil
}

func (hub *collaborationHub) removeClient(client *collaborationClient) {
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	hub.mu.Lock()
	if hub.clients[client.id] != client {
		hub.mu.Unlock()
		return
	}
	delete(hub.clients, client.id)
	for _, participant := range hub.clients {
		if participant.followingClientID == client.id {
			participant.followingClientID = ""
		}
	}
	holder := hub.holder == client
	if holder {
		hub.holder = nil
		hub.leaseMode = ""
	}
	hub.mu.Unlock()
	if holder {
		_ = hub.input.release(client.ownerID)
		hub.broadcastLeaseState()
	} else {
		hub.broadcastPresence()
	}
}

func (hub *collaborationHub) handleClientMessage(client *collaborationClient, message collaborationClientMessage) error {
	switch message.Type {
	case "input.claim":
		mode := message.Mode
		if mode != collaborationLeaseImplicit && mode != collaborationLeaseExplicit {
			return errors.New("invalid input lease mode")
		}
		return hub.claim(client, message.TargetID, mode)
	case "input.release":
		return hub.release(client)
	case "input.heartbeat":
		return hub.heartbeat(client)
	case "input.pointer.motion.absolute", "input.pointer.button", "input.pointer.scroll", "input.keyboard.key", "input.keyboard.text":
		return hub.submit(client, message)
	case "presence.active-target":
		return hub.updateActiveTarget(client, message.TargetID)
	case "presence.cursor":
		return hub.updateCursor(client, message.TargetID, message.X, message.Y)
	case "presence.cursor.clear":
		hub.clearCursor(client)
		return nil
	case "follow.set":
		return hub.setFollowing(client, message.FollowingClientID)
	case "paint.point":
		return hub.paintPoint(client, message)
	default:
		return errors.New("unknown collaboration message type")
	}
}

func (hub *collaborationHub) paintPoint(client *collaborationClient, message collaborationClientMessage) error {
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
	hub.mu.Lock()
	now := time.Now()
	if message.Phase == "start" && client.activeTargetID != message.TargetID {
		hub.mu.Unlock()
		return errors.New("paint target is unavailable")
	}
	if message.Phase != "start" && (client.activePaintStroke != message.StrokeID || client.activePaintTarget != message.TargetID) {
		hub.mu.Unlock()
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
		if hub.paintTokensAt.IsZero() {
			hub.paintTokens = collaborationPaintHubBurst
		} else {
			hub.paintTokens += now.Sub(hub.paintTokensAt).Seconds() * collaborationPaintHubRate
			if hub.paintTokens > collaborationPaintHubBurst {
				hub.paintTokens = collaborationPaintHubBurst
			}
		}
		hub.paintTokensAt = now
		hubTokenCost := 1.0
		if message.Phase == "start" {
			hubTokenCost = 2
		}
		if client.paintTokens < 1 || hub.paintTokens < hubTokenCost {
			hub.mu.Unlock()
			return nil
		}
		client.paintTokens--
		hub.paintTokens -= hubTokenCost
		if message.Phase == "start" {
			client.activePaintStroke = message.StrokeID
			client.activePaintTarget = message.TargetID
		}
	}
	hub.mu.Unlock()
	hub.broadcastPaint(collaborationServerMessage{
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

func (hub *collaborationHub) broadcastPaint(message collaborationServerMessage) {
	hub.mu.Lock()
	clients := make([]*collaborationClient, 0, len(hub.clients))
	for _, client := range hub.clients {
		clients = append(clients, client)
	}
	hub.mu.Unlock()
	for _, client := range clients {
		client.queuePaintUpdate(message)
	}
}

func (hub *collaborationHub) updateActiveTarget(client *collaborationClient, targetID string) error {
	targetID = strings.TrimSpace(targetID)
	if len(targetID) > 128 {
		return errors.New("active target is invalid")
	}
	if targetID != "" && !hub.knownTarget(targetID) {
		return errors.New("active target is unavailable")
	}
	hub.mu.Lock()
	client.activeTargetID = targetID
	hub.mu.Unlock()
	hub.broadcastPresence()
	return nil
}

func (hub *collaborationHub) updateCursor(client *collaborationClient, targetID string, x, y float64) error {
	if targetID == "" || x < 0 || x > 1 || y < 0 || y > 1 {
		return errors.New("cursor position is invalid")
	}
	message := collaborationServerMessage{Version: 1, Type: "presence.cursor", ClientID: client.id, TargetID: targetID, X: x, Y: y}
	hub.mu.Lock()
	if client.activeTargetID != targetID {
		hub.mu.Unlock()
		return errors.New("cursor target is unavailable")
	}
	followers := make([]*collaborationClient, 0)
	for _, participant := range hub.clients {
		if participant.followingClientID == client.id {
			followers = append(followers, participant)
		}
	}
	hub.mu.Unlock()
	for _, follower := range followers {
		follower.queueCursorUpdate(message)
	}
	return nil
}

func (hub *collaborationHub) clearCursor(client *collaborationClient) {
	message := collaborationServerMessage{Version: 1, Type: "presence.cursor.clear", ClientID: client.id}
	hub.mu.Lock()
	followers := make([]*collaborationClient, 0)
	for _, participant := range hub.clients {
		if participant.followingClientID == client.id {
			followers = append(followers, participant)
		}
	}
	hub.mu.Unlock()
	for _, follower := range followers {
		follower.queueCursorUpdate(message)
	}
}

func (client *collaborationClient) queuePresenceUpdate(message collaborationServerMessage) {
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

func (client *collaborationClient) writePresenceUpdates(ctx context.Context) {
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

func (client *collaborationClient) queueCursorUpdate(message collaborationServerMessage) {
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

func (client *collaborationClient) writeCursorUpdates(ctx context.Context) {
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

func (client *collaborationClient) queuePaintUpdate(message collaborationServerMessage) {
	select {
	case client.paintUpdates <- message:
	default:
		_ = client.socket.CloseNow()
	}
}

func (client *collaborationClient) writePaintUpdates(ctx context.Context) {
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

func (hub *collaborationHub) setFollowing(client *collaborationClient, followingClientID string) error {
	hub.mu.Lock()
	if followingClientID == "" {
		client.followingClientID = ""
		hub.mu.Unlock()
		hub.broadcastPresence()
		return nil
	}
	followed := hub.clients[followingClientID]
	if followed == nil {
		hub.mu.Unlock()
		return errors.New("followed participant is unavailable")
	}
	for current := followed; current != nil; current = hub.clients[current.followingClientID] {
		if current == client {
			hub.mu.Unlock()
			return errors.New("follow cycle is not allowed")
		}
		if current.followingClientID == "" {
			break
		}
	}
	client.followingClientID = followingClientID
	hub.mu.Unlock()
	hub.broadcastPresence()
	return nil
}

func (hub *collaborationHub) claim(client *collaborationClient, targetID string, mode collaborationLeaseMode) error {
	if client.role == "viewer" {
		return errors.New("viewer input is disabled")
	}
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	hub.mu.Lock()
	if hub.closed || hub.clients[client.id] != client {
		hub.mu.Unlock()
		return remoteinput.ErrNotReady
	}
	if hub.holder == client {
		if hub.leaseMode != collaborationLeaseExplicit {
			hub.leaseMode = mode
		}
		hub.lastSeen = time.Now()
		hub.mu.Unlock()
		if err := hub.bindInputTarget(client, targetID); err != nil {
			hub.releaseInputAndRevoke(client)
			return err
		}
		if !hub.clientHoldsInput(client) {
			_ = hub.input.release(client.ownerID)
			return remoteinput.ErrNotReady
		}
		hub.broadcastLeaseState()
		return nil
	}
	ownerPreemptsEditor := client.role == "owner" && hub.holder != nil && hub.holder.role == "editor"
	canPreempt := mode == collaborationLeaseExplicit && (hub.leaseMode == collaborationLeaseImplicit || ownerPreemptsEditor)
	if hub.holder != nil && hub.holder != client && !canPreempt {
		hub.mu.Unlock()
		return remoteinput.ErrBusy
	}
	previous := hub.holder
	hub.holder = client
	hub.leaseMode = mode
	hub.lastSeen = time.Now()
	hub.mu.Unlock()
	if previous != nil {
		_ = hub.input.release(previous.ownerID)
	}
	if err := hub.bindInputTarget(client, targetID); err != nil {
		hub.releaseInputAndRevoke(client)
		return err
	}
	if !hub.clientHoldsInput(client) {
		_ = hub.input.release(client.ownerID)
		return remoteinput.ErrNotReady
	}
	hub.broadcastLeaseState()
	return nil
}

func (hub *collaborationHub) heartbeat(client *collaborationClient) error {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.holder != client {
		return remoteinput.ErrNotOwner
	}
	hub.lastSeen = time.Now()
	return nil
}

func (hub *collaborationHub) release(client *collaborationClient) error {
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	hub.mu.Lock()
	if hub.holder != client {
		hub.mu.Unlock()
		return remoteinput.ErrNotOwner
	}
	hub.holder = nil
	hub.leaseMode = ""
	hub.mu.Unlock()
	err := hub.input.release(client.ownerID)
	hub.broadcastLeaseState()
	return err
}

func (hub *collaborationHub) revoke(client *collaborationClient) {
	hub.mu.Lock()
	if hub.holder != client {
		hub.mu.Unlock()
		return
	}
	hub.holder = nil
	hub.leaseMode = ""
	hub.mu.Unlock()
	hub.broadcastLeaseState()
}

func (hub *collaborationHub) submit(client *collaborationClient, message collaborationClientMessage) error {
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	hub.mu.Lock()
	if hub.holder != client {
		hub.mu.Unlock()
		return remoteinput.ErrNotOwner
	}
	if message.Sequence <= client.sequence {
		hub.mu.Unlock()
		return errors.New("input sequence must increase")
	}
	hub.mu.Unlock()
	if err := hub.bindInputTarget(client, message.TargetID); err != nil {
		hub.releaseInputAndRevoke(client)
		return err
	}
	hub.mu.Lock()
	if hub.holder != client {
		hub.mu.Unlock()
		_ = hub.input.release(client.ownerID)
		return remoteinput.ErrNotOwner
	}
	client.sequence = message.Sequence
	hub.lastSeen = time.Now()
	hub.mu.Unlock()
	if err := hub.input.submit(client.ownerID, message); err != nil {
		hub.releaseInputAndRevoke(client)
		return err
	}
	return nil
}

func (hub *collaborationHub) bindInputTarget(client *collaborationClient, targetID string) error {
	return hub.input.bind(client.ownerID, targetID, func() {
		hub.revoke(client)
	})
}

func (hub *collaborationHub) releaseInputAndRevoke(client *collaborationClient) {
	_ = hub.input.release(client.ownerID)
	hub.revoke(client)
}

func (hub *collaborationHub) clientHoldsInput(client *collaborationClient) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return hub.holder == client
}

func (hub *collaborationHub) knownTarget(targetID string) bool {
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	known, err := hub.input.hasTarget(targetID)
	return err == nil && known
}

func (hub *collaborationHub) expireLease() {
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	hub.mu.Lock()
	if hub.holder == nil || time.Since(hub.lastSeen) < collaborationLeaseTimeout {
		hub.mu.Unlock()
		return
	}
	holder := hub.holder
	hub.holder = nil
	hub.leaseMode = ""
	hub.mu.Unlock()
	_ = hub.input.release(holder.ownerID)
	hub.broadcastLeaseState()
}

func (hub *collaborationHub) sendLeaseState(client *collaborationClient) {
	hub.leaseUpdatesMu.Lock()
	defer hub.leaseUpdatesMu.Unlock()
	hub.mu.Lock()
	message := hub.leaseStateLocked()
	hub.mu.Unlock()
	client.queueLeaseUpdate(message)
}

func (hub *collaborationHub) broadcastLeaseState() {
	hub.leaseUpdatesMu.Lock()
	defer hub.leaseUpdatesMu.Unlock()
	hub.mu.Lock()
	message := hub.leaseStateLocked()
	hub.mu.Unlock()
	hub.broadcast(message)
	hub.broadcastPresence()
}

func (hub *collaborationHub) broadcastPresence() {
	hub.presenceMu.Lock()
	defer hub.presenceMu.Unlock()

	hub.mu.Lock()
	participants := make([]collaborationParticipant, 0, len(hub.clients))
	clients := make([]*collaborationClient, 0, len(hub.clients))
	for _, client := range hub.clients {
		clients = append(clients, client)
		participant := collaborationParticipant{
			ClientID:          client.id,
			Name:              client.name,
			AvatarHash:        client.avatarHash,
			Role:              client.role,
			ActiveTargetID:    client.activeTargetID,
			FollowingClientID: client.followingClientID,
			HoldingInput:      hub.holder == client,
		}
		if hub.holder == client {
			participant.LeaseMode = hub.leaseMode
		}
		participants = append(participants, participant)
	}
	hub.mu.Unlock()
	sort.Slice(participants, func(left, right int) bool {
		return participants[left].ClientID < participants[right].ClientID
	})
	message := collaborationServerMessage{Version: 1, Type: "presence.state", Participants: participants}
	for _, client := range clients {
		client.queuePresenceUpdate(message)
	}
}

func (hub *collaborationHub) broadcast(message collaborationServerMessage) {
	hub.mu.Lock()
	clients := make([]*collaborationClient, 0, len(hub.clients))
	for _, client := range hub.clients {
		clients = append(clients, client)
	}
	hub.mu.Unlock()
	for _, client := range clients {
		client.queueLeaseUpdate(message)
	}
}

func (client *collaborationClient) queueLeaseUpdate(message collaborationServerMessage) {
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

func (client *collaborationClient) writeLeaseUpdates(ctx context.Context) {
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

func (hub *collaborationHub) leaseStateLocked() collaborationServerMessage {
	message := collaborationServerMessage{Version: 1, Type: "input.state", Mode: hub.leaseMode}
	if hub.holder != nil {
		message.HolderClientID = hub.holder.id
	}
	return message
}

func (client *collaborationClient) write(message collaborationServerMessage) error {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), collaborationWriteTimeout)
	defer cancel()
	return client.socket.Write(ctx, websocket.MessageText, mustJSON(message))
}

func (client *collaborationClient) writeError(code, message string) {
	_ = client.write(collaborationServerMessage{Version: 1, Type: "error", Code: code, Message: message})
}

func mustJSON(value any) []byte {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return body
}

func (hub *collaborationHub) close() {
	hub.inputMu.Lock()
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		hub.inputMu.Unlock()
		return
	}
	hub.closed = true
	clients := make([]*collaborationClient, 0, len(hub.clients))
	for _, client := range hub.clients {
		clients = append(clients, client)
	}
	hub.clients = make(map[string]*collaborationClient)
	hub.holder = nil
	hub.mu.Unlock()
	_ = hub.input.close()
	hub.inputMu.Unlock()
	for _, client := range clients {
		_ = client.socket.Close(websocket.StatusGoingAway, "collaboration stopped")
	}
}

func (hub *collaborationHub) disconnectSessionTokenClients() {
	hub.mu.Lock()
	clients := make([]*collaborationClient, 0)
	for _, client := range hub.clients {
		if client.sessionTokenAuthenticated {
			clients = append(clients, client)
		}
	}
	hub.mu.Unlock()
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
