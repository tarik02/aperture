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
	collaborationProtocol       = "aperture-collaboration.v1"
	collaborationMaximumClients = 20
	collaborationLeaseTimeout   = 5 * time.Second
	collaborationWriteTimeout   = 5 * time.Second
)

type collaborationLeaseMode string

const (
	collaborationLeaseImplicit collaborationLeaseMode = "implicit"
	collaborationLeaseExplicit collaborationLeaseMode = "explicit"
)

type collaborationHub struct {
	runtime    *wrapperRuntime
	controller *remoteinput.Controller
	sender     *compositorInputSender

	mu         sync.Mutex
	inputMu    sync.Mutex
	presenceMu sync.Mutex
	clients    map[string]*collaborationClient
	holder     *collaborationClient
	leaseMode  collaborationLeaseMode
	lastSeen   time.Time
	nextOwner  uint64
	closed     bool

	inputSurfaceID  uint64
	inputGeneration uint64
	inputWidth      int
	inputHeight     int
}

type collaborationClient struct {
	hub               *collaborationHub
	id                string
	role              string
	ownerID           uint64
	socket            *websocket.Conn
	writeMu           sync.Mutex
	presenceUpdates   chan collaborationServerMessage
	cursorUpdates     chan collaborationServerMessage
	sequence          uint64
	name              string
	avatarHash        string
	activeTargetID    string
	followingClientID string
	lastPaintAt       time.Time
	activePaintStroke string
}

type collaborationClientMessage struct {
	Version           int                    `json:"version"`
	Type              string                 `json:"type"`
	ClientID          string                 `json:"clientId"`
	TargetID          string                 `json:"targetId"`
	Mode              collaborationLeaseMode `json:"mode"`
	Sequence          uint64                 `json:"sequence"`
	X                 float64                `json:"x"`
	Y                 float64                `json:"y"`
	ButtonCode        uint32                 `json:"buttonCode"`
	Keycode           uint32                 `json:"keycode"`
	Text              string                 `json:"text"`
	Pressed           bool                   `json:"pressed"`
	Horizontal        float64                `json:"horizontal"`
	Vertical          float64                `json:"vertical"`
	StopHorizontal    bool                   `json:"stopHorizontal"`
	StopVertical      bool                   `json:"stopVertical"`
	Name              string                 `json:"name"`
	AvatarHash        string                 `json:"avatarHash"`
	FollowingClientID string                 `json:"followingClientId"`
	StrokeID          string                 `json:"strokeId"`
	Color             string                 `json:"color"`
	Width             float64                `json:"width"`
	Phase             string                 `json:"phase"`
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
	controller, err := remoteinput.New(remoteinput.Config{
		Enabled:   true,
		Locking:   true,
		Pointer:   true,
		Keyboard:  true,
		QueueSize: 256,
	})
	if err != nil {
		return nil, err
	}
	sender := newCompositorInputSender(runtime.controlSocket, runtime.values.CompositorWidth, runtime.values.CompositorHeight)
	if err := controller.Attach(remoteinput.Authorization{Pointer: true, Keyboard: true}, sender); err != nil {
		_ = controller.Close()
		return nil, err
	}
	return &collaborationHub{
		runtime:    runtime,
		controller: controller,
		sender:     sender,
		clients:    make(map[string]*collaborationClient),
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
	socket.SetReadLimit(64 * 1024)

	var hello collaborationClientMessage
	if err := readCollaborationMessage(req.Context(), socket, &hello); err != nil {
		_ = socket.Close(websocket.StatusPolicyViolation, "valid hello required")
		return
	}
	name := strings.TrimSpace(hello.Name)
	if hello.Version != 1 || hello.Type != "hello" || !validCollaborationClientID(hello.ClientID) || !validCollaborationName(name) || !validCollaborationAvatarHash(hello.AvatarHash) {
		_ = socket.Close(websocket.StatusPolicyViolation, "valid hello required")
		return
	}
	client, err := hub.addClient(hello.ClientID, role, name, hello.AvatarHash, socket)
	if err != nil {
		_ = socket.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	defer hub.removeClient(client)
	if err := client.write(collaborationServerMessage{Version: 1, Type: "welcome", ClientID: client.id, Role: client.role}); err != nil {
		return
	}
	go client.writePresenceUpdates(req.Context())
	go client.writeCursorUpdates(req.Context())
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

func (hub *collaborationHub) addClient(id, role, name, avatarHash string, socket *websocket.Conn) (*collaborationClient, error) {
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
		hub:             hub,
		id:              id,
		role:            role,
		ownerID:         hub.nextOwner,
		socket:          socket,
		presenceUpdates: make(chan collaborationServerMessage, 1),
		cursorUpdates:   make(chan collaborationServerMessage, 1),
		name:            name,
		avatarHash:      avatarHash,
	}
	hub.clients[id] = client
	return client, nil
}

func (hub *collaborationHub) removeClient(client *collaborationClient) {
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
		_ = hub.controller.Release(client.ownerID)
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
	case "input.pointer.motion.absolute":
		return hub.submit(client, message, remoteinput.Event{Type: remoteinput.EventPointerAbsolute, X: message.X, Y: message.Y})
	case "input.pointer.button":
		return hub.submit(client, message, remoteinput.Event{Type: remoteinput.EventPointerButton, ButtonCode: message.ButtonCode, Pressed: message.Pressed})
	case "input.pointer.scroll":
		return hub.submit(client, message, remoteinput.Event{Type: remoteinput.EventPointerScroll, Horizontal: message.Horizontal, Vertical: message.Vertical, StopHorizontal: message.StopHorizontal, StopVertical: message.StopVertical})
	case "input.keyboard.key":
		return hub.submit(client, message, remoteinput.Event{Type: remoteinput.EventKeyboardKey, Keycode: message.Keycode, Pressed: message.Pressed})
	case "input.keyboard.text":
		return hub.submit(client, message, remoteinput.Event{Type: remoteinput.EventKeyboardText, Text: message.Text})
	case "presence.active-target":
		return hub.updateActiveTarget(client, message.TargetID)
	case "presence.cursor":
		return hub.updateCursor(client, message.TargetID, message.X, message.Y)
	case "follow.set":
		return hub.setFollowing(client, message.FollowingClientID)
	case "paint.point":
		return hub.paintPoint(client, message)
	default:
		return errors.New("unknown collaboration message type")
	}
}

func (hub *collaborationHub) paintPoint(client *collaborationClient, message collaborationClientMessage) error {
	if !validPaintStrokeID(message.StrokeID) || !validPaintColor(message.Color) || message.Width < 1 || message.Width > 16 {
		return errors.New("paint stroke is invalid")
	}
	if message.Phase != "start" && message.Phase != "move" && message.Phase != "end" {
		return errors.New("paint phase is invalid")
	}
	if message.X < 0 || message.X > 1 || message.Y < 0 || message.Y > 1 {
		return errors.New("paint point is invalid")
	}
	if _, ok := hub.readyTarget(message.TargetID); !ok {
		return errors.New("paint target is unavailable")
	}
	hub.mu.Lock()
	now := time.Now()
	switch message.Phase {
	case "start":
		if now.Sub(client.lastPaintAt) < 20*time.Millisecond {
			hub.mu.Unlock()
			return nil
		}
		client.activePaintStroke = message.StrokeID
	case "move":
		if client.activePaintStroke != message.StrokeID || now.Sub(client.lastPaintAt) < 20*time.Millisecond {
			hub.mu.Unlock()
			return nil
		}
	case "end":
		if client.activePaintStroke != message.StrokeID {
			hub.mu.Unlock()
			return nil
		}
		client.activePaintStroke = ""
	}
	client.lastPaintAt = now
	hub.mu.Unlock()
	hub.broadcast(collaborationServerMessage{
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

func (hub *collaborationHub) updateActiveTarget(client *collaborationClient, targetID string) error {
	if len(targetID) > 128 {
		return errors.New("active target is invalid")
	}
	if targetID != "" {
		if _, ok := hub.readyTarget(targetID); !ok {
			return errors.New("active target is unavailable")
		}
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
	if _, ok := hub.readyTarget(targetID); !ok {
		return errors.New("cursor target is unavailable")
	}
	message := collaborationServerMessage{Version: 1, Type: "presence.cursor", ClientID: client.id, TargetID: targetID, X: x, Y: y}
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
	return nil
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
	target, ok := hub.readyTarget(targetID)
	if !ok {
		return remoteinput.ErrNotReady
	}
	hub.inputMu.Lock()
	defer hub.inputMu.Unlock()
	hub.mu.Lock()
	if hub.holder == client {
		if err := hub.bindInputTargetLocked(client, target); err != nil {
			hub.holder = nil
			hub.leaseMode = ""
			hub.mu.Unlock()
			hub.broadcastLeaseState()
			return err
		}
		if hub.leaseMode != collaborationLeaseExplicit {
			hub.leaseMode = mode
		}
		hub.lastSeen = time.Now()
		hub.mu.Unlock()
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
	if previous != nil && previous != client {
		hub.holder = nil
		hub.leaseMode = ""
		_ = hub.controller.Release(previous.ownerID)
	}
	if err := hub.bindInputTargetLocked(client, target); err != nil {
		hub.mu.Unlock()
		hub.broadcastLeaseState()
		return err
	}
	hub.holder = client
	hub.leaseMode = mode
	hub.lastSeen = time.Now()
	hub.mu.Unlock()
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
	hub.mu.Lock()
	if hub.holder != client {
		hub.mu.Unlock()
		return remoteinput.ErrNotOwner
	}
	hub.holder = nil
	hub.leaseMode = ""
	hub.mu.Unlock()
	err := hub.controller.Release(client.ownerID)
	hub.broadcastLeaseState()
	return err
}

func (hub *collaborationHub) revoke(client *collaborationClient) {
	hub.mu.Lock()
	if hub.holder == client {
		hub.holder = nil
		hub.leaseMode = ""
	}
	hub.mu.Unlock()
	hub.broadcastLeaseState()
}

func (hub *collaborationHub) submit(client *collaborationClient, message collaborationClientMessage, event remoteinput.Event) error {
	target, ok := hub.readyTarget(message.TargetID)
	if !ok {
		return remoteinput.ErrNotReady
	}
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
	if err := hub.bindInputTargetLocked(client, target); err != nil {
		hub.holder = nil
		hub.leaseMode = ""
		hub.mu.Unlock()
		hub.broadcastLeaseState()
		return err
	}
	client.sequence = message.Sequence
	hub.lastSeen = time.Now()
	hub.mu.Unlock()
	event.Sequence = message.Sequence
	return hub.controller.Submit(client.ownerID, event)
}

func (hub *collaborationHub) bindInputTargetLocked(client *collaborationClient, target wrapperTargetSnapshot) error {
	targetUnchanged := hub.inputSurfaceID == target.SurfaceID &&
		hub.inputGeneration == target.Generation &&
		hub.inputWidth == target.Viewport.Width &&
		hub.inputHeight == target.Viewport.Height
	ownsInput := hub.controller.Owns(client.ownerID)
	if targetUnchanged && ownsInput {
		return nil
	}
	if ownsInput {
		if err := hub.controller.Release(client.ownerID); err != nil {
			return err
		}
	}
	hub.sender.SetTarget(target.SurfaceID, target.Viewport.Width, target.Viewport.Height)
	if _, err := hub.controller.Acquire(client.ownerID, func(uint64, error) {
		hub.revoke(client)
	}); err != nil {
		return err
	}
	hub.inputSurfaceID = target.SurfaceID
	hub.inputGeneration = target.Generation
	hub.inputWidth = target.Viewport.Width
	hub.inputHeight = target.Viewport.Height
	return nil
}

func (hub *collaborationHub) readyTarget(targetID string) (wrapperTargetSnapshot, bool) {
	hub.runtime.mu.Lock()
	registry := hub.runtime.targets
	hub.runtime.mu.Unlock()
	if registry == nil || strings.TrimSpace(targetID) == "" {
		return wrapperTargetSnapshot{}, false
	}
	return registry.readyTarget(targetID)
}

func (hub *collaborationHub) expireLease() {
	hub.mu.Lock()
	if hub.holder == nil || time.Since(hub.lastSeen) < collaborationLeaseTimeout {
		hub.mu.Unlock()
		return
	}
	holder := hub.holder
	hub.holder = nil
	hub.leaseMode = ""
	hub.mu.Unlock()
	_ = hub.controller.Release(holder.ownerID)
	hub.broadcastLeaseState()
}

func (hub *collaborationHub) sendLeaseState(client *collaborationClient) {
	hub.mu.Lock()
	message := hub.leaseStateLocked()
	hub.mu.Unlock()
	_ = client.write(message)
}

func (hub *collaborationHub) broadcastLeaseState() {
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
		_ = client.write(message)
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
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
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
	for _, client := range clients {
		_ = client.socket.Close(websocket.StatusGoingAway, "collaboration stopped")
	}
	_ = hub.controller.Close()
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
