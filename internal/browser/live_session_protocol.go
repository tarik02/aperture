package browser

import (
	"errors"
	"strings"
)

func (session *liveSession) handleSessionMessage(client *liveSessionClient, transport liveSessionTransport, message liveSessionClientMessage, delivery liveSessionDelivery) {
	if liveSessionMessageChangesTargets(message.Type) {
		unlock := session.lockTargetChanges()
		defer unlock()
	} else {
		client.handoverMu.Lock()
		defer client.handoverMu.Unlock()
	}
	if client.transport() != transport {
		return
	}
	if message.Version != 1 {
		writeLiveSessionTransportError(transport, "invalid_version", "unsupported live session protocol version")
		return
	}
	expectedDelivery, known := liveSessionMessageDelivery(message)
	if !known {
		writeLiveSessionTransportError(transport, "request_rejected", "unknown live session message")
		return
	}
	if delivery != expectedDelivery {
		writeLiveSessionTransportError(transport, "invalid_delivery", "live session message used the wrong delivery lane")
		return
	}
	if delivery == liveSessionDeliveryRealtime {
		session.mu.Lock()
		if message.RealtimeCounter <= client.realtimeCounter {
			session.mu.Unlock()
			return
		}
		client.realtimeCounter = message.RealtimeCounter
		session.mu.Unlock()
	}

	if isLiveSessionCommand(message.Type) {
		if !validLiveSessionRequestID(message.RequestID) {
			writeLiveSessionTransportError(transport, "invalid_request", "live session command requires a valid request ID")
			return
		}
		result, err := session.handleSessionCommand(client, message)
		if err != nil {
			session.writeCommandError(transport, message, err)
			return
		}
		result.Version = 1
		result.Type = message.Type + ".result"
		result.RequestID = message.RequestID
		result.OK = liveSessionBool(true)
		_ = transport.send(liveSessionDeliveryReliable, mustJSON(result))
		return
	}

	if err := session.handleClientMessage(client, message); err != nil {
		writeLiveSessionTransportError(transport, liveSessionErrorCode(err), err.Error())
	}
}

func liveSessionMessageChangesTargets(messageType string) bool {
	switch messageType {
	case "target.select", "target.create", "target.close", "follow.set":
		return true
	default:
		return false
	}
}

func liveSessionMessageDelivery(message liveSessionClientMessage) (liveSessionDelivery, bool) {
	switch message.Type {
	case "input.pointer.motion.absolute", "presence.cursor":
		return liveSessionDeliveryRealtime, true
	case "paint.point":
		if message.Phase == "move" {
			return liveSessionDeliveryRealtime, true
		}
		return liveSessionDeliveryReliable, message.Phase == "start" || message.Phase == "end"
	case "input.claim",
		"input.release",
		"input.heartbeat",
		"input.pointer.button",
		"input.pointer.scroll",
		"input.keyboard.key",
		"input.keyboard.text",
		"presence.cursor.clear",
		"follow.set":
		return liveSessionDeliveryReliable, true
	default:
		return liveSessionDeliveryReliable, isLiveSessionCommand(message.Type)
	}
}

func isLiveSessionCommand(messageType string) bool {
	switch messageType {
	case "target.select",
		"target.create",
		"target.close",
		"page.navigate",
		"page.history-back",
		"page.history-forward",
		"page.reload",
		"page.stop-loading",
		"viewport.set",
		"recording.start",
		"recording.stop",
		"recording.cancel":
		return true
	default:
		return false
	}
}

func (session *liveSession) handleSessionCommand(client *liveSessionClient, message liveSessionClientMessage) (liveSessionServerMessage, error) {
	switch message.Type {
	case "target.select":
		if !session.knownTarget(message.TargetID) {
			return liveSessionServerMessage{}, errors.New("browser target is unavailable")
		}
		if client.transport() == nil {
			return liveSessionServerMessage{}, errors.New("session transport is recovering")
		}
		if err := session.updateActiveTarget(client, message.TargetID); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{TargetID: message.TargetID}, nil
	case "target.create":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		targetID, err := session.browser.createTarget(message.URL)
		if err != nil {
			return liveSessionServerMessage{}, err
		}
		if err := session.updateActiveTarget(client, targetID); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{TargetID: targetID}, nil
	case "target.close":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		if err := session.browser.closeTarget(message.TargetID); err != nil {
			return liveSessionServerMessage{}, err
		}
		session.reconcileAndBroadcastTargetsLocked()
		return liveSessionServerMessage{TargetID: message.TargetID}, nil
	case "page.navigate":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{}, session.browser.navigate(message.TargetID, message.URL)
	case "page.history-back":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{}, session.browser.navigateHistory(message.TargetID, -1)
	case "page.history-forward":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{}, session.browser.navigateHistory(message.TargetID, 1)
	case "page.reload":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{}, session.browser.reload(message.TargetID)
	case "page.stop-loading":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{}, session.browser.stopLoading(message.TargetID)
	case "viewport.set":
		if err := requireBrowserMutation(client); err != nil {
			return liveSessionServerMessage{}, err
		}
		return liveSessionServerMessage{}, session.browser.setViewport(
			message.TargetID,
			int(message.Width),
			int(message.Height),
			message.DeviceScaleFactor,
		)
	case "recording.start":
		if client.role != "owner" {
			return liveSessionServerMessage{}, errors.New("recording requires the owner role")
		}
		recording, err := session.startRecording(wrapperRecordingRequest{
			Mode:        wrapperRecordingMode(message.Mode),
			TargetID:    message.TargetID,
			ClientID:    client.id,
			FPS:         message.FPS,
			BitrateKbps: message.BitrateKbps,
			Codec:       message.Codec,
		})
		if err != nil {
			return liveSessionServerMessage{}, err
		}
		session.broadcastRecordings()
		return liveSessionServerMessage{Recording: &recording}, nil
	case "recording.stop", "recording.cancel":
		if client.role != "owner" {
			return liveSessionServerMessage{}, errors.New("recording requires the owner role")
		}
		reason := "requested"
		if message.Type == "recording.cancel" {
			reason = "canceled"
		}
		recording, err := session.stopRecording(message.RecordingID, reason)
		if err != nil {
			return liveSessionServerMessage{}, err
		}
		session.broadcastRecordings()
		return liveSessionServerMessage{Recording: &recording}, nil
	default:
		return liveSessionServerMessage{}, errors.New("unknown live session command")
	}
}

func (session *liveSession) writeCommandError(transport liveSessionTransport, request liveSessionClientMessage, err error) {
	_ = transport.send(liveSessionDeliveryReliable, mustJSON(liveSessionServerMessage{
		Version:   1,
		Type:      request.Type + ".result",
		RequestID: request.RequestID,
		OK:        liveSessionBool(false),
		Code:      liveSessionErrorCode(err),
		Message:   err.Error(),
	}))
}

func writeLiveSessionTransportError(transport liveSessionTransport, code, message string) {
	_ = transport.send(liveSessionDeliveryReliable, mustJSON(liveSessionServerMessage{
		Version: 1,
		Type:    "error",
		Code:    code,
		Message: message,
	}))
}

func liveSessionBool(value bool) *bool {
	return &value
}

func (session *liveSession) broadcastTargets() {
	targets, err := session.browser.targets()
	if err != nil {
		return
	}
	session.publishTargets(targets)
}

func (session *liveSession) publishTargets(targets []liveSessionTarget) {
	session.mu.Lock()
	type targetRecipient struct {
		client         *liveSessionClient
		activeTargetID string
	}
	clients := make([]targetRecipient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, targetRecipient{client: client, activeTargetID: client.activeTargetID})
	}
	session.mu.Unlock()
	for _, recipient := range clients {
		recipient.client.queueStateUpdate(liveSessionServerMessage{
			Version:        1,
			Type:           "targets.state",
			Targets:        targets,
			ActiveTargetID: recipient.activeTargetID,
		})
	}
}

func (session *liveSession) reconcileAndBroadcastTargets() {
	unlock := session.lockTargetChanges()
	defer unlock()
	session.reconcileAndBroadcastTargetsLocked()
}

func (session *liveSession) reconcileAndBroadcastTargetsLocked() {
	targets, err := session.browser.targets()
	if err != nil {
		return
	}
	available := make(map[string]struct{}, len(targets))
	replacementTargetID := ""
	session.runtime.mu.Lock()
	hasTargetRegistry := session.runtime.targets != nil
	session.runtime.mu.Unlock()
	for _, target := range targets {
		available[target.ID] = struct{}{}
		if replacementTargetID == "" && (!hasTargetRegistry || target.Viewport != nil) {
			replacementTargetID = target.ID
		}
	}

	session.mu.Lock()
	changes := make([]liveSessionTargetChange, 0)
	for _, client := range session.clients {
		_, activeTargetAvailable := available[client.activeTargetID]
		if client.activeTargetID == "" || !activeTargetAvailable {
			changes = append(changes, liveSessionTargetChange{
				client:           client,
				previousTargetID: client.activeTargetID,
			})
		}
	}
	session.mu.Unlock()
	if len(changes) > 0 && replacementTargetID != "" {
		err = session.applyActiveTargetChanges(changes, replacementTargetID)
	}
	if len(changes) > 0 && (replacementTargetID == "" || err != nil) {
		session.mu.Lock()
		for _, change := range changes {
			change.client.activeTargetID = ""
		}
		session.mu.Unlock()
	}
	if len(changes) > 0 {
		session.broadcastPresence()
	}
	session.publishTargets(targets)
}

func (session *liveSession) broadcastRecordings() {
	message := liveSessionServerMessage{
		Version:    1,
		Type:       "recordings.state",
		Recordings: session.listRecordings(),
	}
	session.mu.Lock()
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		if client.role == "owner" {
			clients = append(clients, client)
		}
	}
	session.mu.Unlock()
	for _, client := range clients {
		client.queueStateUpdate(message)
	}
}

func requireBrowserMutation(client *liveSessionClient) error {
	if client.role == "viewer" {
		return errors.New("viewer browser control is disabled")
	}
	return nil
}

func validLiveSessionRequestID(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 128 && validLiveSessionClientID("request-"+value)
}
