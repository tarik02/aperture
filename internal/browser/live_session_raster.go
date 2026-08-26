package browser

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type liveSessionRaster struct {
	session   *liveSession
	transport *liveSessionWebSocketTransport

	mu        sync.Mutex
	client    *liveSessionCDP
	targetID  string
	sessionID string
	closed    bool
}

type liveSessionRasterFrame struct {
	Version           int     `json:"version"`
	Type              string  `json:"type"`
	TargetID          string  `json:"targetId"`
	FrameID           int64   `json:"frameId"`
	Format            string  `json:"format"`
	Width             float64 `json:"width"`
	Height            float64 `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
	ScrollOffsetX     float64 `json:"scrollOffsetX"`
	ScrollOffsetY     float64 `json:"scrollOffsetY"`
	Timestamp         float64 `json:"timestamp,omitempty"`
}

func newLiveSessionRaster(session *liveSession, transport *liveSessionWebSocketTransport) *liveSessionRaster {
	return &liveSessionRaster{session: session, transport: transport}
}

func (raster *liveSessionRaster) selectTarget(targetID string) error {
	raster.mu.Lock()
	defer raster.mu.Unlock()
	if raster.closed {
		return errors.New("WebSocket presentation is closed")
	}
	if raster.targetID == targetID && raster.sessionID != "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(raster.session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	if raster.client == nil {
		client, err := connectLiveSessionCDP(ctx, raster.session.runtime.values.CDPPort)
		if err != nil {
			return err
		}
		raster.client = client
		go raster.forward(client)
	}
	if err := raster.stopLocked(ctx); err != nil {
		return err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := raster.client.call(ctx, "Target.attachToTarget", map[string]any{
		"targetId": targetID,
		"flatten":  true,
	}, "", &attached); err != nil {
		return err
	}
	if attached.SessionID == "" {
		return errors.New("browser omitted the raster target attachment ID")
	}
	raster.targetID = targetID
	raster.sessionID = attached.SessionID
	if err := raster.client.call(ctx, "Page.enable", map[string]any{}, attached.SessionID, nil); err != nil {
		_ = raster.stopLocked(ctx)
		return err
	}
	if err := raster.client.call(ctx, "Page.startScreencast", map[string]any{
		"format":  "jpeg",
		"quality": 80,
	}, attached.SessionID, nil); err != nil {
		_ = raster.stopLocked(ctx)
		return err
	}
	return nil
}

func (raster *liveSessionRaster) forward(client *liveSessionCDP) {
	for {
		select {
		case <-client.done:
			raster.mu.Lock()
			active := !raster.closed && raster.client == client
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

func (raster *liveSessionRaster) forwardFrame(client *liveSessionCDP, event liveSessionCDPEvent) {
	var frame struct {
		Data      string `json:"data"`
		SessionID int64  `json:"sessionId"`
		Metadata  struct {
			DeviceWidth   float64 `json:"deviceWidth"`
			DeviceHeight  float64 `json:"deviceHeight"`
			PageScale     float64 `json:"pageScaleFactor"`
			ScrollOffsetX float64 `json:"scrollOffsetX"`
			ScrollOffsetY float64 `json:"scrollOffsetY"`
			Timestamp     float64 `json:"timestamp"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(event.Params, &frame); err != nil {
		return
	}
	raster.mu.Lock()
	if raster.closed || raster.client != client || raster.sessionID != event.SessionID {
		raster.mu.Unlock()
		return
	}
	targetID := raster.targetID
	sessionID := raster.sessionID
	raster.mu.Unlock()
	image, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil {
		return
	}
	header, err := json.Marshal(liveSessionRasterFrame{
		Version:           1,
		Type:              "presentation.frame",
		TargetID:          targetID,
		FrameID:           frame.SessionID,
		Format:            "jpeg",
		Width:             frame.Metadata.DeviceWidth,
		Height:            frame.Metadata.DeviceHeight,
		DeviceScaleFactor: frame.Metadata.PageScale,
		ScrollOffsetX:     frame.Metadata.ScrollOffsetX,
		ScrollOffsetY:     frame.Metadata.ScrollOffsetY,
		Timestamp:         frame.Metadata.Timestamp,
	})
	if err != nil || len(header) > int(^uint32(0)) {
		return
	}
	packet := make([]byte, 4+len(header)+len(image))
	binary.BigEndian.PutUint32(packet[:4], uint32(len(header)))
	copy(packet[4:], header)
	copy(packet[4+len(header):], image)
	if err := raster.transport.sendBinary(packet); err != nil {
		raster.transport.closeNow()
		return
	}
	ctx, cancel := context.WithTimeout(raster.session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	_ = client.call(ctx, "Page.screencastFrameAck", map[string]any{"sessionId": frame.SessionID}, sessionID, nil)
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
	}
}

func (raster *liveSessionRaster) stopLocked(ctx context.Context) error {
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
