package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	remoteinput "github.com/tarik02/webdesktop/input"
)

const (
	liveSessionMaximumClients   = 20
	liveSessionHelloTimeout     = 5 * time.Second
	liveSessionLeaseTimeout     = 5 * time.Second
	liveSessionWriteTimeout     = 5 * time.Second
	liveSessionClientPaintRate  = 50
	liveSessionClientPaintBurst = 20
	liveSessionPaintRate        = 100
	liveSessionPaintQueueSize   = 64
	liveSessionPaintBurst       = liveSessionPaintQueueSize
)

type liveSessionLeaseMode string

const (
	liveSessionLeaseImplicit liveSessionLeaseMode = "implicit"
	liveSessionLeaseExplicit liveSessionLeaseMode = "explicit"
)

type liveSessionInput interface {
	bind(ownerID uint64, targetID string, onRevoke func()) error
	hasTarget(targetID string) (bool, error)
	submit(ownerID uint64, message liveSessionClientMessage) error
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
	browser *liveSessionBrowser

	mu             sync.Mutex
	inputMu        sync.Mutex
	recordingMu    sync.Mutex
	leaseUpdatesMu sync.Mutex
	presenceMu     sync.Mutex
	clients        map[string]*liveSessionClient
	holder         liveSessionActor
	leaseMode      liveSessionLeaseMode
	lastSeen       time.Time
	nextOwner      uint64
	closed         bool
	paintTokens    float64
	paintTokensAt  time.Time
	recordings     map[string]*wrapperRecording
}

type liveSessionClient struct {
	id                        string
	role                      string
	ownerID                   uint64
	ctx                       context.Context
	cancel                    context.CancelFunc
	handoverMu                sync.Mutex
	transportMu               sync.RWMutex
	activeTransport           liveSessionTransport
	leaseUpdates              chan liveSessionServerMessage
	stateUpdates              chan liveSessionServerMessage
	presenceUpdates           chan liveSessionServerMessage
	cursorUpdates             chan liveSessionServerMessage
	paintUpdates              chan liveSessionServerMessage
	closeRequests             chan liveSessionCloseRequest
	sequence                  uint64
	resumeSecret              string
	recovering                bool
	recoveryTimer             *time.Timer
	recoveryGeneration        uint64
	realtimeCounter           uint64
	outboundRealtimeCounter   atomic.Uint64
	pressedButtons            map[uint32]struct{}
	pressedKeys               map[string]struct{}
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

type liveSessionCloseRequest struct {
	transport liveSessionTransport
	reason    string
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

type liveSessionClientMessage struct {
	Version               int     `json:"version"`
	Type                  string  `json:"type"`
	RequestID             string  `json:"requestId"`
	ClientID              string  `json:"clientId"`
	ResumeSecret          string  `json:"resumeSecret"`
	TargetID              string  `json:"targetId"`
	URL                   string  `json:"url"`
	Mode                  string  `json:"mode"`
	Sequence              uint64  `json:"sequence"`
	X                     float64 `json:"x"`
	Y                     float64 `json:"y"`
	ButtonCode            uint32  `json:"buttonCode"`
	Keycode               uint32  `json:"keycode"`
	Text                  string  `json:"text"`
	Key                   string  `json:"key"`
	Code                  string  `json:"code"`
	UnmodifiedText        string  `json:"unmodifiedText"`
	Pressed               bool    `json:"pressed"`
	Width                 float64 `json:"width"`
	Height                float64 `json:"height"`
	ClickCount            int     `json:"clickCount"`
	Modifiers             int     `json:"modifiers"`
	WindowsVirtualKeyCode int     `json:"windowsVirtualKeyCode"`
	NativeVirtualKeyCode  int     `json:"nativeVirtualKeyCode"`
	Location              int     `json:"location"`
	AutoRepeat            bool    `json:"autoRepeat"`
	IsKeypad              bool    `json:"isKeypad"`
	Horizontal            float64 `json:"horizontal"`
	Vertical              float64 `json:"vertical"`
	StopHorizontal        bool    `json:"stopHorizontal"`
	StopVertical          bool    `json:"stopVertical"`
	Name                  string  `json:"name"`
	AvatarHash            string  `json:"avatarHash"`
	FollowingClientID     string  `json:"followingClientId"`
	StrokeID              string  `json:"strokeId"`
	Color                 string  `json:"color"`
	Phase                 string  `json:"phase"`
	DeviceScaleFactor     float64 `json:"deviceScaleFactor"`
	RecordingID           string  `json:"recordingId"`
	FPS                   int     `json:"fps"`
	BitrateKbps           int     `json:"bitrateKbps"`
	Codec                 string  `json:"codec"`
	RealtimeCounter       uint64  `json:"realtimeCounter"`
}

type liveSessionParticipant struct {
	ClientID          string               `json:"clientId"`
	Name              string               `json:"name"`
	AvatarHash        string               `json:"avatarHash"`
	Role              string               `json:"role"`
	ActiveTargetID    string               `json:"activeTargetId,omitempty"`
	FollowingClientID string               `json:"followingClientId,omitempty"`
	HoldingInput      bool                 `json:"holdingInput"`
	LeaseMode         liveSessionLeaseMode `json:"leaseMode,omitempty"`
	Recovering        bool                 `json:"recovering,omitempty"`
}

type liveSessionServerMessage struct {
	Version         int                      `json:"version"`
	Type            string                   `json:"type"`
	RequestID       string                   `json:"requestId,omitempty"`
	OK              *bool                    `json:"ok,omitempty"`
	ClientID        string                   `json:"clientId,omitempty"`
	ResumeSecret    string                   `json:"resumeSecret,omitempty"`
	Role            string                   `json:"role,omitempty"`
	Transport       string                   `json:"transport,omitempty"`
	HolderClientID  string                   `json:"holderClientId,omitempty"`
	Mode            liveSessionLeaseMode     `json:"mode,omitempty"`
	Code            string                   `json:"code,omitempty"`
	Message         string                   `json:"message,omitempty"`
	TargetID        string                   `json:"targetId,omitempty"`
	ActiveTargetID  string                   `json:"activeTargetId,omitempty"`
	Targets         []liveSessionTarget      `json:"targets,omitempty"`
	X               *float64                 `json:"x,omitempty"`
	Y               *float64                 `json:"y,omitempty"`
	Participants    []liveSessionParticipant `json:"participants,omitempty"`
	StrokeID        string                   `json:"strokeId,omitempty"`
	Color           string                   `json:"color,omitempty"`
	Width           float64                  `json:"width,omitempty"`
	Phase           string                   `json:"phase,omitempty"`
	Recordings      []wrapperRecording       `json:"recordings,omitempty"`
	Recording       *wrapperRecording        `json:"recording,omitempty"`
	RealtimeCounter uint64                   `json:"realtimeCounter,omitempty"`
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
		runtime:    runtime,
		input:      input,
		browser:    newLiveSessionBrowser(runtime),
		clients:    make(map[string]*liveSessionClient),
		recordings: make(map[string]*wrapperRecording),
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
			session.mu.Lock()
			hasClients := len(session.clients) > 0
			session.mu.Unlock()
			if hasClients {
				session.reconcileAndBroadcastTargets()
			}
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

func liveSessionErrorCode(err error) string {
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

func (session *liveSession) addClient(id, role, name, avatarHash, capabilityRole string, sessionTokenAuthenticated bool) (*liveSessionClient, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil, errors.New("collaboration is unavailable")
	}
	if len(session.clients) >= liveSessionMaximumClients {
		return nil, errors.New("live session client limit reached")
	}
	if _, exists := session.clients[id]; exists {
		return nil, errors.New("collaboration client id is already connected")
	}
	session.nextOwner++
	clientCtx, cancelClient := context.WithCancel(session.runtime.ctx)
	client := &liveSessionClient{
		id:                        id,
		role:                      role,
		ownerID:                   session.nextOwner,
		ctx:                       clientCtx,
		cancel:                    cancelClient,
		leaseUpdates:              make(chan liveSessionServerMessage, 1),
		stateUpdates:              make(chan liveSessionServerMessage, 16),
		presenceUpdates:           make(chan liveSessionServerMessage, 1),
		cursorUpdates:             make(chan liveSessionServerMessage, 1),
		paintUpdates:              make(chan liveSessionServerMessage, liveSessionPaintQueueSize),
		closeRequests:             make(chan liveSessionCloseRequest, 4),
		pressedButtons:            make(map[uint32]struct{}),
		pressedKeys:               make(map[string]struct{}),
		name:                      name,
		avatarHash:                avatarHash,
		capabilityRole:            capabilityRole,
		sessionTokenAuthenticated: sessionTokenAuthenticated,
	}
	session.clients[id] = client
	go client.writeLeaseUpdates(client.ctx)
	go client.writeStateUpdates(client.ctx)
	go client.writePresenceUpdates(client.ctx)
	go client.writeCursorUpdates(client.ctx)
	go client.writePaintUpdates(client.ctx)
	go client.closeRequestedTransports(client.ctx)
	return client, nil
}

func (session *liveSession) removeClient(client *liveSessionClient) {
	client.handoverMu.Lock()
	defer client.handoverMu.Unlock()
	session.recordingMu.Lock()
	session.inputMu.Lock()
	session.mu.Lock()
	if session.clients[client.id] != client {
		session.mu.Unlock()
		session.inputMu.Unlock()
		session.recordingMu.Unlock()
		return
	}
	delete(session.clients, client.id)
	client.cancel()
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
	session.recordingMu.Unlock()
	if holder {
		_ = session.input.release(client.ownerID)
		session.inputMu.Unlock()
		session.broadcastLeaseState()
	} else {
		session.inputMu.Unlock()
		session.broadcastPresence()
	}
	session.stopClientRecordings(client.id)
}

func (session *liveSession) handleClientMessage(client *liveSessionClient, message liveSessionClientMessage) error {
	switch message.Type {
	case "input.claim":
		mode := liveSessionLeaseMode(message.Mode)
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

func (session *liveSession) paintPoint(client *liveSessionClient, message liveSessionClientMessage) error {
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
			client.paintTokens = liveSessionClientPaintBurst
		} else {
			client.paintTokens += now.Sub(client.paintTokensAt).Seconds() * liveSessionClientPaintRate
			if client.paintTokens > liveSessionClientPaintBurst {
				client.paintTokens = liveSessionClientPaintBurst
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
	x := message.X
	y := message.Y
	session.broadcastPaint(liveSessionServerMessage{
		Version:  1,
		Type:     "paint.point",
		ClientID: client.id,
		TargetID: message.TargetID,
		StrokeID: message.StrokeID,
		Color:    message.Color,
		Width:    message.Width,
		Phase:    message.Phase,
		X:        &x,
		Y:        &y,
	})
	return nil
}

func (session *liveSession) broadcastPaint(message liveSessionServerMessage) {
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
	if targetID == "" || len(targetID) > 128 {
		return errors.New("active target is invalid")
	}
	if !session.knownTarget(targetID) {
		return errors.New("active target is unavailable")
	}
	session.recordingMu.Lock()
	defer session.recordingMu.Unlock()
	session.mu.Lock()
	changes := session.activeTargetChangesLocked(client)
	session.mu.Unlock()
	if err := session.applyActiveTargetChanges(changes, targetID); err != nil {
		return err
	}
	session.broadcastTargets()
	session.broadcastPresence()
	return nil
}

func (session *liveSession) activeTargetChangesLocked(client *liveSessionClient) []liveSessionTargetChange {
	changes := []liveSessionTargetChange{{client: client, previousTargetID: client.activeTargetID}}
	for index := 0; index < len(changes); index++ {
		followed := changes[index].client
		for _, participant := range session.clients {
			if participant.followingClientID == followed.id {
				changes = append(changes, liveSessionTargetChange{
					client:           participant,
					previousTargetID: participant.activeTargetID,
				})
			}
		}
	}
	return changes
}

type liveSessionTargetChange struct {
	client           *liveSessionClient
	previousTargetID string
	transport        liveSessionTransport
}

// applyActiveTargetChanges runs while recordingMu prevents client and follow changes.
func (session *liveSession) applyActiveTargetChanges(changes []liveSessionTargetChange, targetID string) error {
	changed := changes[:0]
	for _, change := range changes {
		if change.previousTargetID != targetID {
			change.transport = change.client.transport()
			changed = append(changed, change)
		}
	}
	if len(changed) == 0 {
		return nil
	}

	rotatedRecordings := 0
	selectedTransports := 0
	rollback := func(cause error) error {
		rollbackErrors := []error{cause}
		for index := selectedTransports - 1; index >= 0; index-- {
			change := changed[index]
			if change.transport == nil {
				continue
			}
			if change.previousTargetID == "" {
				change.transport.close("presentation rollback failed")
				continue
			}
			if err := change.transport.selectTarget(change.previousTargetID); err != nil {
				change.transport.close("presentation rollback failed")
				rollbackErrors = append(rollbackErrors, fmt.Errorf("restore presentation for client %s: %w", change.client.id, err))
			}
		}
		for index := rotatedRecordings - 1; index >= 0; index-- {
			change := changed[index]
			if change.previousTargetID == "" {
				continue
			}
			if err := session.moveViewerRecordings(session.runtime.ctx, change.client.id, change.previousTargetID); err != nil {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("restore viewer recordings for client %s: %w", change.client.id, err))
			}
		}
		return errors.Join(rollbackErrors...)
	}

	for _, change := range changed {
		if err := session.moveViewerRecordings(session.runtime.ctx, change.client.id, targetID); err != nil {
			return rollback(err)
		}
		rotatedRecordings++
	}
	for _, change := range changed {
		if change.transport != nil {
			if err := change.transport.selectTarget(targetID); err != nil {
				return rollback(err)
			}
		}
		selectedTransports++
	}

	session.mu.Lock()
	for _, change := range changed {
		change.client.activeTargetID = targetID
	}
	session.mu.Unlock()
	return nil
}

func (session *liveSession) updateCursor(client *liveSessionClient, targetID string, x, y float64) error {
	if targetID == "" || x < 0 || x > 1 || y < 0 || y > 1 {
		return errors.New("cursor position is invalid")
	}
	message := liveSessionServerMessage{Version: 1, Type: "presence.cursor", ClientID: client.id, TargetID: targetID, X: &x, Y: &y}
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
	message := liveSessionServerMessage{Version: 1, Type: "presence.cursor.clear", ClientID: client.id}
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

func (client *liveSessionClient) queuePresenceUpdate(message liveSessionServerMessage) {
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
				continue
			}
		}
	}
}

func (client *liveSessionClient) queueCursorUpdate(message liveSessionServerMessage) {
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
			if client.writeDelivery(liveSessionDeliveryRealtime, message) != nil {
				continue
			}
		}
	}
}

func (client *liveSessionClient) queuePaintUpdate(message liveSessionServerMessage) {
	select {
	case client.paintUpdates <- message:
	default:
		client.requestTransportClose("session write queue is full")
	}
}

func (client *liveSessionClient) writePaintUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.paintUpdates:
			delivery := liveSessionDeliveryReliable
			if message.Phase == "move" {
				delivery = liveSessionDeliveryRealtime
			}
			if client.writeDelivery(delivery, message) != nil {
				continue
			}
		}
	}
}

func (session *liveSession) setFollowing(client *liveSessionClient, followingClientID string) error {
	session.recordingMu.Lock()
	defer session.recordingMu.Unlock()
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
	targetID := followed.activeTargetID
	changes := session.activeTargetChangesLocked(client)
	session.mu.Unlock()
	if targetID != "" {
		if err := session.applyActiveTargetChanges(changes, targetID); err != nil {
			return err
		}
	}
	session.mu.Lock()
	client.followingClientID = followingClientID
	session.mu.Unlock()
	session.broadcastTargets()
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
	clear(client.pressedButtons)
	clear(client.pressedKeys)
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

func (session *liveSession) submit(client *liveSessionClient, message liveSessionClientMessage) error {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	session.mu.Lock()
	if session.holder != client {
		session.mu.Unlock()
		return remoteinput.ErrNotOwner
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
	client.sequence++
	message.Sequence = client.sequence
	session.lastSeen = time.Now()
	session.mu.Unlock()
	if err := session.input.submit(client.ownerID, message); err != nil {
		session.releaseInputAndRevoke(client)
		return err
	}
	session.mu.Lock()
	switch message.Type {
	case "input.pointer.button":
		if message.Pressed {
			client.pressedButtons[message.ButtonCode] = struct{}{}
		} else {
			delete(client.pressedButtons, message.ButtonCode)
		}
	case "input.keyboard.key":
		keyID := liveSessionInputKeyID(message)
		if message.Pressed {
			client.pressedKeys[keyID] = struct{}{}
		} else {
			delete(client.pressedKeys, keyID)
		}
	}
	session.mu.Unlock()
	return nil
}

func liveSessionInputKeyID(message liveSessionClientMessage) string {
	if message.Code != "" {
		return "code:" + message.Code
	}
	if message.Keycode != 0 {
		return "keycode:" + strconv.FormatUint(uint64(message.Keycode), 10)
	}
	return "key:" + message.Key
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
	participants := session.participantsLocked()
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, client)
	}
	session.mu.Unlock()
	message := liveSessionServerMessage{Version: 1, Type: "presence.state", Participants: participants}
	for _, client := range clients {
		client.queuePresenceUpdate(message)
	}
}

func (session *liveSession) participantsLocked() []liveSessionParticipant {
	participants := make([]liveSessionParticipant, 0, len(session.clients)+1)
	for _, client := range session.clients {
		participant := liveSessionParticipant{
			ClientID:          client.id,
			Name:              client.name,
			AvatarHash:        client.avatarHash,
			Role:              client.role,
			ActiveTargetID:    client.activeTargetID,
			FollowingClientID: client.followingClientID,
			HoldingInput:      session.holder == client,
			Recovering:        client.recovering,
		}
		if session.holder == client {
			participant.LeaseMode = session.leaseMode
		}
		participants = append(participants, participant)
	}
	if automation, ok := session.holder.(*liveSessionAutomation); ok {
		participants = append(participants, liveSessionParticipant{
			ClientID:     automation.actorID(),
			Name:         automation.actorName(),
			Role:         automation.actorRole(),
			HoldingInput: true,
			LeaseMode:    session.leaseMode,
		})
	}
	sort.Slice(participants, func(left, right int) bool {
		return participants[left].ClientID < participants[right].ClientID
	})
	return participants
}

func (session *liveSession) broadcast(message liveSessionServerMessage) {
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

func (client *liveSessionClient) queueLeaseUpdate(message liveSessionServerMessage) {
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

func (client *liveSessionClient) queueStateUpdate(message liveSessionServerMessage) {
	select {
	case client.stateUpdates <- message:
	default:
		client.requestTransportClose("session state queue is full")
	}
}

func (client *liveSessionClient) writeStateUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.stateUpdates:
			if client.write(message) != nil {
				continue
			}
		}
	}
}

func (client *liveSessionClient) writeLeaseUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-client.leaseUpdates:
			if client.write(message) != nil {
				continue
			}
		}
	}
}

func (session *liveSession) leaseStateLocked() liveSessionServerMessage {
	message := liveSessionServerMessage{Version: 1, Type: "input.state", Mode: session.leaseMode}
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
	if !validLiveSessionName(name) {
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

func (client *liveSessionClient) write(message liveSessionServerMessage) error {
	return client.writeDelivery(liveSessionDeliveryReliable, message)
}

func (client *liveSessionClient) writeDelivery(delivery liveSessionDelivery, message liveSessionServerMessage) error {
	client.handoverMu.Lock()
	defer client.handoverMu.Unlock()
	transport := client.transport()
	if transport == nil {
		return nil
	}
	if delivery == liveSessionDeliveryRealtime {
		message.RealtimeCounter = client.outboundRealtimeCounter.Add(1)
	}
	err := transport.send(delivery, mustJSON(message))
	if err != nil {
		client.requestTransportCloseFor(transport, "session write failed")
	}
	return err
}

func (client *liveSessionClient) transport() liveSessionTransport {
	client.transportMu.RLock()
	defer client.transportMu.RUnlock()
	return client.activeTransport
}

func (client *liveSessionClient) closeTransport(reason string) {
	client.transportMu.RLock()
	transport := client.activeTransport
	client.transportMu.RUnlock()
	if transport != nil {
		transport.close(reason)
	}
}

func (client *liveSessionClient) requestTransportClose(reason string) {
	transport := client.transport()
	if transport == nil {
		return
	}
	client.requestTransportCloseFor(transport, reason)
}

func (client *liveSessionClient) requestTransportCloseFor(transport liveSessionTransport, reason string) {
	request := liveSessionCloseRequest{transport: transport, reason: reason}
	select {
	case client.closeRequests <- request:
	default:
	}
}

func (client *liveSessionClient) closeRequestedTransports(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case request := <-client.closeRequests:
			if client.transport() == request.transport {
				request.transport.close(request.reason)
			}
		}
	}
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
	session.browser.close()
	session.inputMu.Unlock()
	for _, client := range clients {
		client.cancel()
		client.closeTransport("live session stopped")
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
		client.closeTransport("session capability rotated")
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
		client.closeTransport("collaboration capability rotated")
	}
}

func validLiveSessionClientID(value string) bool {
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

func validLiveSessionName(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && utf8.RuneCountInString(value) <= 48
}

func validLiveSessionAvatarHash(value string) bool {
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
	return validLiveSessionClientID(value)
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
