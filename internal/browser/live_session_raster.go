package browser

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

type liveSessionRaster struct {
	session   *liveSession
	transport *liveSessionWebSocketTransport

	mu         sync.Mutex
	client     *liveSessionCDP
	targetID   string
	sessionID  string
	selection  chan error
	frameReady chan struct{}
	done       chan struct{}
	doneOnce   sync.Once
	pending    *liveSessionRasterSourceFrame
	closed     bool
}

type liveSessionRasterFrame struct {
	Type     string  `json:"type"`
	TargetID string  `json:"targetId"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
}

type liveSessionRasterSourceFrame struct {
	data         string
	targetID     string
	width        float64
	height       float64
	cdpFrameID   int64
	cdpSessionID string
}

func newLiveSessionRaster(session *liveSession, transport *liveSessionWebSocketTransport) *liveSessionRaster {
	return &liveSessionRaster{
		session:    session,
		transport:  transport,
		frameReady: make(chan struct{}, 1),
		done:       make(chan struct{}),
	}
}

func (raster *liveSessionRaster) selectTarget(targetID string) error {
	raster.mu.Lock()
	if raster.closed {
		raster.mu.Unlock()
		return errors.New("WebSocket presentation is closed")
	}
	if raster.targetID == targetID && raster.sessionID != "" {
		raster.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithTimeout(raster.session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	if raster.client == nil {
		client, err := connectLiveSessionCDP(ctx, raster.session.runtime.values.CDPPort)
		if err != nil {
			raster.mu.Unlock()
			return err
		}
		raster.client = client
		go raster.forward(client)
		go raster.sendFrames(client)
	}
	if err := raster.stopLocked(ctx); err != nil {
		raster.mu.Unlock()
		return err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := raster.client.call(ctx, "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	}, "", &attached); err != nil {
		raster.mu.Unlock()
		return err
	}
	if attached.SessionID == "" {
		raster.mu.Unlock()
		return errors.New("browser omitted the raster target attachment ID")
	}
	raster.targetID = targetID
	raster.sessionID = attached.SessionID
	selection := make(chan error, 1)
	raster.selection = selection
	if err := raster.client.call(ctx, "Page.enable", map[string]any{}, attached.SessionID, nil); err != nil {
		_ = raster.stopLocked(ctx)
		raster.mu.Unlock()
		return err
	}
	if err := raster.client.call(ctx, "Page.startScreencast", map[string]any{
		"format":            "jpeg",
		"quality":           80,
		"maxFramesInFlight": 1,
	}, attached.SessionID, nil); err != nil {
		_ = raster.stopLocked(ctx)
		raster.mu.Unlock()
		return err
	}
	raster.mu.Unlock()
	select {
	case err := <-selection:
		return err
	case <-ctx.Done():
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), time.Second)
		defer cancelCleanup()
		raster.mu.Lock()
		if raster.selection != selection {
			raster.mu.Unlock()
			return <-selection
		}
		raster.completeSelectionLocked(ctx.Err())
		_ = raster.stopLocked(cleanupCtx)
		raster.mu.Unlock()
		return fmt.Errorf("WebSocket presentation did not produce a frame: %w", ctx.Err())
	}
}

func (raster *liveSessionRaster) forward(client *liveSessionCDP) {
	defer raster.doneOnce.Do(func() { close(raster.done) })
	for {
		select {
		case <-client.done:
			raster.mu.Lock()
			active := !raster.closed && raster.client == client
			if active {
				raster.completeSelectionLocked(errors.New("WebSocket presentation source closed"))
			}
			raster.mu.Unlock()
			if active {
				raster.transport.closeNow()
			}
			return
		case event := <-client.events:
			if event.Method == "Page.screencastFrame" {
				raster.forwardFrame(client, event)
			}
		}
	}
}

func (raster *liveSessionRaster) sendFrames(client *liveSessionCDP) {
	for {
		select {
		case <-raster.done:
			return
		case <-raster.frameReady:
			raster.mu.Lock()
			pending := raster.pending
			raster.pending = nil
			raster.mu.Unlock()
			if pending != nil {
				raster.presentFrame(client, *pending)
			}
		}
	}
}

func (raster *liveSessionRaster) forwardFrame(client *liveSessionCDP, event liveSessionCDPEvent) {
	var frame struct {
		Data      string `json:"data"`
		SessionID int64  `json:"sessionId"`
		Metadata  struct {
			DeviceWidth  float64 `json:"deviceWidth"`
			DeviceHeight float64 `json:"deviceHeight"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(event.Params, &frame); err != nil {
		return
	}
	source := liveSessionRasterSourceFrame{
		data:         frame.Data,
		width:        frame.Metadata.DeviceWidth,
		height:       frame.Metadata.DeviceHeight,
		cdpFrameID:   frame.SessionID,
		cdpSessionID: event.SessionID,
	}
	raster.mu.Lock()
	if raster.closed || raster.client != client || raster.sessionID != event.SessionID {
		raster.mu.Unlock()
		return
	}
	source.targetID = raster.targetID
	raster.mu.Unlock()
	if !raster.acknowledgeCDPFrame(client, source) {
		return
	}
	raster.mu.Lock()
	if raster.closed || raster.client != client || raster.sessionID != source.cdpSessionID || raster.targetID != source.targetID {
		raster.mu.Unlock()
		return
	}
	raster.pending = &source
	raster.mu.Unlock()
	select {
	case raster.frameReady <- struct{}{}:
	default:
	}
}

func (raster *liveSessionRaster) presentFrame(client *liveSessionCDP, source liveSessionRasterSourceFrame) {
	image, err := base64.StdEncoding.DecodeString(source.data)
	if err != nil {
		raster.failFrame(client, source, fmt.Errorf("decode WebSocket presentation frame: %w", err))
		return
	}
	raster.mu.Lock()
	if raster.closed || raster.client != client || raster.sessionID != source.cdpSessionID || raster.targetID != source.targetID {
		raster.mu.Unlock()
		return
	}
	selection := raster.selection
	raster.mu.Unlock()
	header, err := json.Marshal(liveSessionRasterFrame{
		Type:     "presentation.frame",
		TargetID: source.targetID,
		Width:    source.width,
		Height:   source.height,
	})
	if err != nil || len(header) > int(^uint32(0)) {
		raster.failFrame(client, source, errors.New("encode WebSocket presentation frame header"))
		return
	}
	packet := make([]byte, 4+len(header)+len(image))
	binary.BigEndian.PutUint32(packet[:4], uint32(len(header)))
	copy(packet[4:], header)
	copy(packet[4+len(header):], image)
	if err := raster.transport.sendBinary(packet); err != nil {
		raster.mu.Lock()
		if raster.selection == selection {
			raster.completeSelectionLocked(err)
		}
		raster.mu.Unlock()
		raster.transport.closeNow()
		return
	}
	raster.mu.Lock()
	if raster.client == client && raster.sessionID == source.cdpSessionID && raster.selection == selection {
		raster.completeSelectionLocked(nil)
	}
	raster.mu.Unlock()
}

func (raster *liveSessionRaster) failFrame(client *liveSessionCDP, source liveSessionRasterSourceFrame, err error) {
	raster.mu.Lock()
	if raster.closed || raster.client != client || raster.sessionID != source.cdpSessionID || raster.targetID != source.targetID {
		raster.mu.Unlock()
		return
	}
	raster.completeSelectionLocked(err)
	raster.mu.Unlock()
	raster.transport.closeNow()
}

func (raster *liveSessionRaster) acknowledgeCDPFrame(client *liveSessionCDP, source liveSessionRasterSourceFrame) bool {
	raster.mu.Lock()
	if raster.closed || raster.client != client || raster.sessionID != source.cdpSessionID {
		raster.mu.Unlock()
		return false
	}
	raster.mu.Unlock()
	ctx, cancel := context.WithTimeout(raster.session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	if err := client.sendBestEffort(
		ctx,
		"Page.screencastFrameAck",
		map[string]any{"sessionId": source.cdpFrameID},
		source.cdpSessionID,
	); err != nil {
		raster.transport.closeNow()
		return false
	}
	return true
}

func (raster *liveSessionRaster) close() {
	raster.mu.Lock()
	defer raster.mu.Unlock()
	if raster.closed {
		return
	}
	raster.closed = true
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = raster.stopLocked(ctx)
	if raster.client != nil {
		raster.client.close()
		raster.client = nil
	} else {
		raster.doneOnce.Do(func() { close(raster.done) })
	}
}

func (raster *liveSessionRaster) stopLocked(ctx context.Context) error {
	raster.completeSelectionLocked(errors.New("WebSocket presentation selection was replaced"))
	raster.pending = nil
	if raster.client == nil || raster.sessionID == "" {
		raster.targetID = ""
		raster.sessionID = ""
		return nil
	}
	sessionID := raster.sessionID
	raster.targetID = ""
	raster.sessionID = ""
	stopErr := raster.client.call(ctx, "Page.stopScreencast", map[string]any{}, sessionID, nil)
	detachErr := raster.client.call(ctx, "Target.detachFromTarget", map[string]any{"sessionId": sessionID}, "", nil)
	return errors.Join(stopErr, detachErr)
}

func (raster *liveSessionRaster) completeSelectionLocked(err error) {
	if raster.selection == nil {
		return
	}
	raster.selection <- err
	raster.selection = nil
}
