package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	recordingClientProtocol         = "aperture-recording.v1"
	recordingClientMessageByteLimit = 64 * 1024
	recordingClientHeartbeatTimeout = 2 * time.Minute
)

type wrapperRecordingClient struct {
	id       string
	targetID string
	cancel   context.CancelFunc
}

type wrapperRecordingClientMessage struct {
	Version  int    `json:"version"`
	Type     string `json:"type"`
	TargetID string `json:"targetId"`
}

func (r *wrapperRuntime) handleRecordingClient(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	clientID := req.URL.Query().Get("clientId")
	parsedClientID, err := uuid.Parse(clientID)
	if err != nil || parsedClientID.String() != clientID {
		writeWrapperError(w, http.StatusBadRequest, "clientId must be a UUID")
		return
	}
	connection, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		Subprotocols: []string{recordingClientProtocol},
	})
	if err != nil {
		return
	}
	if connection.Subprotocol() != recordingClientProtocol {
		_ = connection.Close(websocket.StatusPolicyViolation, "recording subprotocol is required")
		return
	}
	ctx, cancel := context.WithCancel(r.ctx)
	client := &wrapperRecordingClient{id: clientID, cancel: cancel}
	if !r.claimRecordingClient(client) {
		cancel()
		_ = connection.Close(websocket.StatusPolicyViolation, "recording client is already connected")
		return
	}
	defer func() {
		cancel()
		r.releaseRecordingClient(client)
		_ = connection.Close(websocket.StatusNormalClosure, "recording client disconnected")
	}()
	connection.SetReadLimit(recordingClientMessageByteLimit)
	for {
		readCtx, cancelRead := context.WithTimeout(ctx, recordingClientHeartbeatTimeout)
		messageType, body, err := connection.Read(readCtx)
		cancelRead()
		if err != nil {
			return
		}
		if messageType != websocket.MessageText {
			_ = connection.Close(websocket.StatusUnsupportedData, "text messages are required")
			return
		}
		var message wrapperRecordingClientMessage
		if err := json.Unmarshal(body, &message); err != nil || message.Version != 1 {
			_ = connection.Close(websocket.StatusPolicyViolation, "invalid recording client message")
			return
		}
		if message.Type == "heartbeat" {
			continue
		}
		if message.Type != "target.select" || strings.TrimSpace(message.TargetID) == "" {
			_ = connection.Close(websocket.StatusPolicyViolation, "invalid recording client message")
			return
		}
		if err := r.selectRecordingClientTarget(ctx, client, message.TargetID); err != nil {
			response, _ := json.Marshal(map[string]any{
				"version":  1,
				"type":     "target.select.result",
				"ok":       false,
				"targetId": message.TargetID,
				"error":    err.Error(),
			})
			if err := connection.Write(ctx, websocket.MessageText, response); err != nil {
				return
			}
			continue
		}
		response, _ := json.Marshal(map[string]any{
			"version":  1,
			"type":     "target.select.result",
			"ok":       true,
			"targetId": message.TargetID,
		})
		if err := connection.Write(ctx, websocket.MessageText, response); err != nil {
			return
		}
	}
}

func (r *wrapperRuntime) claimRecordingClient(client *wrapperRecordingClient) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recordingClients[client.id] != nil {
		return false
	}
	r.recordingClients[client.id] = client
	return true
}

func (r *wrapperRuntime) releaseRecordingClient(client *wrapperRecordingClient) {
	r.mu.Lock()
	if r.recordingClients[client.id] != client {
		r.mu.Unlock()
		return
	}
	delete(r.recordingClients, client.id)
	recordingIDs := make([]string, 0)
	for _, recording := range r.recordings {
		if recording.clientID == client.id &&
			(recording.Status == wrapperRecordingStarting || recording.Status == wrapperRecordingRunning) {
			recordingIDs = append(recordingIDs, recording.ID)
		}
	}
	r.mu.Unlock()
	for _, recordingID := range recordingIDs {
		_, _ = r.stopRecording(recordingID, "client_disconnected")
	}
}

func (r *wrapperRuntime) selectRecordingClientTarget(ctx context.Context, client *wrapperRecordingClient, targetID string) error {
	r.mu.Lock()
	registry := r.targets
	r.mu.Unlock()
	if registry == nil {
		return errors.New("target registry is unavailable")
	}
	target, exists := registry.readyTarget(targetID)
	if !exists {
		return errors.New("target is not ready")
	}
	r.mu.Lock()
	if r.recordingClients[client.id] != client {
		r.mu.Unlock()
		return errors.New("recording client is disconnected")
	}
	client.targetID = targetID
	type recordingTargetCandidate struct {
		recording *wrapperRecording
		targetID  string
	}
	recordings := make([]recordingTargetCandidate, 0)
	for _, recording := range r.recordings {
		if recording.Mode == wrapperRecordingModeViewer && recording.clientID == client.id && recording.Status == wrapperRecordingRunning {
			recordings = append(recordings, recordingTargetCandidate{recording: recording, targetID: recording.TargetID})
		}
	}
	r.mu.Unlock()
	for _, candidate := range recordings {
		if err := r.rotateRecordingTarget(ctx, candidate.recording, target, candidate.targetID); err != nil {
			return err
		}
	}
	return nil
}
