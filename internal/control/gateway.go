package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/target"
	"github.com/coder/websocket"
)

const uiReadLimit = 1 << 20

// Gateway bridges a UI WebSocket to a running session's browser CDP endpoint.
type Gateway struct {
	sessionID string
	cdpPort   int
	uiConn    *websocket.Conn

	writeMu sync.Mutex
	stateMu sync.Mutex

	browser        *browserConn
	cdpCtx         context.Context
	activeTargetID target.ID
	screencast     screencastState
}

type screencastState struct {
	running   bool
	targetID  target.ID
	sessionID target.SessionID
	format    string
}

// Run serves the control gateway until the client disconnects or ctx is canceled.
func Run(ctx context.Context, sessionID string, cdpPort int, uiConn *websocket.Conn) error {
	uiConn.SetReadLimit(uiReadLimit)

	gatewayCtx, cancelGateway := context.WithCancel(ctx)
	defer cancelGateway()

	gw := &Gateway{
		sessionID: sessionID,
		cdpPort:   cdpPort,
		uiConn:    uiConn,
	}

	browser, err := dialBrowser(gatewayCtx, cdpPort)
	if err != nil {
		return err
	}
	gw.browser = browser
	gw.cdpCtx = browser.CDPContext(gatewayCtx)
	defer browser.Close()

	if err := target.SetDiscoverTargets(true).Do(gw.cdpCtx); err != nil {
		return fmt.Errorf("enable target discovery: %w", err)
	}

	eventDone := make(chan struct{})
	go func() {
		defer close(eventDone)
		gw.handleCDPEvents(gatewayCtx)
	}()

	if err := gw.sendTargetsSnapshot(ctx); err != nil {
		cancelGateway()
		browser.Close()
		<-eventDone
		return err
	}

	uiCtx, cancelUI := context.WithCancel(ctx)
	defer cancelUI()

	go func() {
		select {
		case <-eventDone:
			cancelUI()
		case <-uiCtx.Done():
		}
	}()

	readErr := gw.readClientMessages(uiCtx)

	_ = gw.stopScreencast(gatewayCtx)
	cancelGateway()
	browser.Close()
	<-eventDone
	return readErr
}

func (g *Gateway) readClientMessages(ctx context.Context) error {
	for {
		_, data, err := g.uiConn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}

		msg, err := parseClientMessage(data)
		if err != nil {
			_ = g.writeError(ctx, errCodeInvalidRequest, "invalid control message")
			continue
		}
		if msg.Type == "" {
			_ = g.writeError(ctx, errCodeInvalidRequest, "control message type is required")
			continue
		}

		if err := g.handleClientMessage(ctx, msg); err != nil {
			_ = g.writeError(ctx, errCodeBrowserControlFailed, err.Error())
		}
	}
}

func (g *Gateway) handleClientMessage(ctx context.Context, msg clientMessage) error {
	switch msg.Type {
	case msgTargetsList:
		return g.sendTargetsSnapshot(ctx)
	case msgTargetsActivate:
		return g.activateTarget(ctx, msg.TargetID)
	case msgScreencastStart:
		return g.startScreencast(ctx, msg)
	case msgScreencastStop:
		return g.stopScreencast(ctx)
	case msgTargetsCreate, msgTargetsClose, msgPageNavigate, msgPageReload, msgPageStopLoading,
		msgViewportSet, msgInputMouse, msgInputWheel, msgInputKey,
		msgClipboardCopy, msgClipboardCut, msgClipboardPaste:
		return g.writeError(ctx, errCodeNotImplemented, msg.Type+" is not implemented yet")
	default:
		return g.writeError(ctx, errCodeInvalidRequest, "unknown control message type")
	}
}

func (g *Gateway) handleCDPEvents(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-g.browser.Events():
			if !ok {
				return
			}
			g.handleCDPEvent(ctx, event)
		}
	}
}

func (g *Gateway) handleCDPEvent(ctx context.Context, event cdpEvent) {
	switch event.Method {
	case "Target.targetCreated":
		var payload target.EventTargetCreated
		if err := json.Unmarshal(event.Params, &payload); err != nil || payload.TargetInfo == nil {
			return
		}
		if !isPageLikeTarget(payload.TargetInfo.Type) {
			return
		}
		_ = g.writeTargetChanged(ctx, "created", payload.TargetInfo)
	case "Target.targetDestroyed":
		var payload target.EventTargetDestroyed
		if err := json.Unmarshal(event.Params, &payload); err != nil {
			return
		}
		g.clearActiveTargetIf(payload.TargetID)
		if state, stopped := g.takeScreencastIfTarget(payload.TargetID); stopped {
			_ = g.writeScreencastStopped(ctx, string(state.targetID))
		}
		_ = g.writeTargetChanged(ctx, "destroyed", &target.Info{
			TargetID: payload.TargetID,
		})
	case "Target.targetInfoChanged":
		var payload target.EventTargetInfoChanged
		if err := json.Unmarshal(event.Params, &payload); err != nil || payload.TargetInfo == nil {
			return
		}
		if !isPageLikeTarget(payload.TargetInfo.Type) {
			return
		}
		_ = g.writeTargetChanged(ctx, "infoChanged", payload.TargetInfo)
	case "Page.screencastFrame":
		g.handleScreencastFrame(ctx, event)
	}
}

func (g *Gateway) handleScreencastFrame(ctx context.Context, event cdpEvent) {
	g.stateMu.Lock()
	sc := g.screencast
	g.stateMu.Unlock()

	if !sc.running || event.SessionID != sc.sessionID {
		return
	}

	var payload page.EventScreencastFrame
	if err := json.Unmarshal(event.Params, &payload); err != nil {
		return
	}

	frame := screencastFrameMessage{
		Type:      msgScreencastFrame,
		SessionID: g.sessionID,
		TargetID:  string(sc.targetID),
		FrameID:   payload.SessionID,
		Format:    sc.format,
		Data:      payload.Data,
	}
	if payload.Metadata != nil {
		frame.Width = payload.Metadata.DeviceWidth
		frame.Height = payload.Metadata.DeviceHeight
		frame.DeviceScaleFactor = payload.Metadata.PageScaleFactor
		frame.ScrollOffsetX = payload.Metadata.ScrollOffsetX
		frame.ScrollOffsetY = payload.Metadata.ScrollOffsetY
		if payload.Metadata.Timestamp != nil {
			frame.Timestamp = float64(time.Time(*payload.Metadata.Timestamp).UnixNano()) / float64(time.Second)
		}
	}

	if err := g.writeUI(ctx, frame); err != nil {
		return
	}

	sessionCtx := withAttachedSession(g.cdpCtx, sc.sessionID)
	_ = page.ScreencastFrameAck(payload.SessionID).Do(sessionCtx)
}

func (g *Gateway) sendTargetsSnapshot(ctx context.Context) error {
	activeTargetID := g.activeTargetIDSnapshot()

	targets, err := g.listPageTargets()
	if err != nil {
		return err
	}
	return g.writeUI(ctx, targetsSnapshotMessage{
		Type:           msgTargetsSnapshot,
		SessionID:      g.sessionID,
		ActiveTargetID: string(activeTargetID),
		Targets:        targets,
	})
}

func (g *Gateway) listPageTargets() ([]targetView, error) {
	infos, err := target.GetTargets().Do(g.cdpCtx)
	if err != nil {
		return nil, err
	}

	views := make([]targetView, 0, len(infos))
	for _, info := range infos {
		if info == nil || !isPageLikeTarget(info.Type) {
			continue
		}
		views = append(views, toTargetView(info))
	}
	return views, nil
}

func (g *Gateway) activateTarget(ctx context.Context, targetIDRaw string) error {
	targetID := target.ID(strings.TrimSpace(targetIDRaw))
	if targetID == "" {
		return errors.New("targetId is required")
	}

	if err := target.ActivateTarget(targetID).Do(g.cdpCtx); err != nil {
		return err
	}
	g.setActiveTargetID(targetID)
	return g.sendTargetsSnapshot(ctx)
}

func (g *Gateway) startScreencast(ctx context.Context, msg clientMessage) error {
	targetID := target.ID(strings.TrimSpace(msg.TargetID))
	if targetID == "" {
		targetID = g.activeTargetIDSnapshot()
	}
	if targetID == "" {
		return errors.New("targetId is required")
	}

	if err := g.stopScreencast(ctx); err != nil {
		return err
	}

	sessionID, err := target.AttachToTarget(targetID).WithFlatten(true).Do(g.cdpCtx)
	if err != nil {
		return err
	}

	format := strings.TrimSpace(msg.Format)
	if format == "" {
		format = "jpeg"
	}

	start := page.StartScreencast().WithFormat(page.ScreencastFormat(format))
	if msg.Quality != nil {
		start = start.WithQuality(*msg.Quality)
	}
	if msg.MaxWidth != nil {
		start = start.WithMaxWidth(*msg.MaxWidth)
	}
	if msg.MaxHeight != nil {
		start = start.WithMaxHeight(*msg.MaxHeight)
	}
	if msg.EveryNthFrame != nil {
		start = start.WithEveryNthFrame(*msg.EveryNthFrame)
	}

	sessionCtx := withAttachedSession(g.cdpCtx, sessionID)
	if err := start.Do(sessionCtx); err != nil {
		_ = target.DetachFromTarget().WithSessionID(sessionID).Do(g.cdpCtx)
		return err
	}

	g.setScreencastState(screencastState{
		running:   true,
		targetID:  targetID,
		sessionID: sessionID,
		format:    format,
	}, targetID)
	return g.sendTargetsSnapshot(ctx)
}

func (g *Gateway) stopScreencast(ctx context.Context) error {
	g.stateMu.Lock()
	if !g.screencast.running {
		g.stateMu.Unlock()
		return nil
	}
	state := g.screencast
	g.screencast = screencastState{}
	g.stateMu.Unlock()

	sessionCtx := withAttachedSession(g.cdpCtx, state.sessionID)
	_ = page.StopScreencast().Do(sessionCtx)
	_ = target.DetachFromTarget().WithSessionID(state.sessionID).Do(g.cdpCtx)

	return g.writeScreencastStopped(ctx, string(state.targetID))
}

func (g *Gateway) activeTargetIDSnapshot() target.ID {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	return g.activeTargetID
}

func (g *Gateway) setActiveTargetID(targetID target.ID) {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	g.activeTargetID = targetID
}

func (g *Gateway) setScreencastState(state screencastState, activeTargetID target.ID) {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	g.screencast = state
	g.activeTargetID = activeTargetID
}

func (g *Gateway) clearActiveTargetIf(targetID target.ID) {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	if g.activeTargetID == targetID {
		g.activeTargetID = ""
	}
}

func (g *Gateway) takeScreencastIfTarget(targetID target.ID) (screencastState, bool) {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()
	if !g.screencast.running || g.screencast.targetID != targetID {
		return screencastState{}, false
	}
	state := g.screencast
	g.screencast = screencastState{}
	return state, true
}

func (g *Gateway) writeScreencastStopped(ctx context.Context, targetID string) error {
	return g.writeUI(ctx, screencastStoppedMessage{
		Type:      msgScreencastStopped,
		SessionID: g.sessionID,
		TargetID:  targetID,
	})
}

func (g *Gateway) writeTargetChanged(ctx context.Context, change string, info *target.Info) error {
	return g.writeUI(ctx, targetChangedMessage{
		Type:   msgTargetChanged,
		Change: change,
		Target: toTargetView(info),
	})
}

func (g *Gateway) writeError(ctx context.Context, code, message string) error {
	return g.writeUI(ctx, errorMessage{
		Type:    msgError,
		Code:    code,
		Message: message,
	})
}

func (g *Gateway) writeUI(ctx context.Context, msg any) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	return g.uiConn.Write(ctx, websocket.MessageText, payload)
}

func isPageLikeTarget(targetType string) bool {
	switch targetType {
	case "page", "webview", "iframe":
		return true
	default:
		return false
	}
}

func toTargetView(info *target.Info) targetView {
	if info == nil {
		return targetView{}
	}
	return targetView{
		ID:       string(info.TargetID),
		Type:     info.Type,
		Title:    info.Title,
		URL:      info.URL,
		Attached: info.Attached,
	}
}
