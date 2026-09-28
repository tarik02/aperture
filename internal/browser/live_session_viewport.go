package browser

import "errors"

var errViewportNotOwned = errors.New("auto-size requires the viewport owner")

// applyHelloAutoSize records the auto-size preference a session client sends with its hello.
// Clients that omit it predate viewport ownership and never receive its state.
func (session *liveSession) applyHelloAutoSize(client *liveSessionClient, autoSize *bool) {
	if autoSize == nil {
		return
	}
	session.mu.Lock()
	client.autoSizeAware = true
	if session.setAutoSizeLocked(client, *autoSize, false) {
		session.broadcastViewportStateLocked()
	}
	session.mu.Unlock()
}

func (session *liveSession) setAutoSize(client *liveSessionClient, enabled bool) error {
	if err := requireBrowserMutation(client); err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	client.autoSizeAware = true
	if session.setAutoSizeLocked(client, enabled, true) {
		session.broadcastViewportStateLocked()
	}
	return nil
}

func (session *liveSession) claimViewportOwner(client *liveSessionClient) error {
	if err := requireBrowserMutation(client); err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	client.autoSizeAware = true
	session.setAutoSizeLocked(client, true, true)
	session.autoSizeSequence++
	client.autoSizeSequence = session.autoSizeSequence
	session.viewportOwner = client
	session.viewportSetExplicitly = false
	session.broadcastViewportStateLocked()
	return nil
}

func (session *liveSession) requireViewportOwner(client *liveSessionClient) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.viewportOwner != client {
		return errViewportNotOwned
	}
	return nil
}

// overrideViewportOwner ends auto-size ownership after an explicit viewport change by any
// other actor. Nobody inherits it, and only an explicit claim or auto-size toggle takes it
// again, so the explicit size survives clients that join with auto-size on by default.
func (session *liveSession) overrideViewportOwner(client *liveSessionClient) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.viewportOwner != nil && session.viewportOwner == client {
		return
	}
	session.viewportSetExplicitly = true
	if session.viewportOwner != nil {
		session.viewportOwner = nil
		session.broadcastViewportStateLocked()
	}
}

// setAutoSizeLocked claims a vacant viewport only through an explicit toggle while an explicit
// viewport change is in effect; a hello preference leaves the client suspended.
func (session *liveSession) setAutoSizeLocked(client *liveSessionClient, enabled bool, explicit bool) bool {
	if client.role == "viewer" {
		enabled = false
	}
	if client.autoSize == enabled {
		return false
	}
	client.autoSize = enabled
	if enabled {
		session.autoSizeSequence++
		client.autoSizeSequence = session.autoSizeSequence
		if session.viewportOwner == nil && (explicit || !session.viewportSetExplicitly) {
			session.viewportOwner = client
			session.viewportSetExplicitly = false
		}
		return true
	}
	if session.viewportOwner == client {
		session.handOverViewportOwnerLocked()
	}
	return true
}

// handOverViewportOwnerLocked passes ownership to the client that enabled auto-size most recently.
func (session *liveSession) handOverViewportOwnerLocked() {
	var next *liveSessionClient
	for _, candidate := range session.clients {
		if !candidate.autoSize {
			continue
		}
		if next == nil || candidate.autoSizeSequence > next.autoSizeSequence {
			next = candidate
		}
	}
	session.viewportOwner = next
}

func (session *liveSession) viewportStateLocked(client *liveSessionClient) liveSessionServerMessage {
	message := liveSessionServerMessage{Type: "viewport.state", AutoSize: liveSessionBool(client.autoSize)}
	if session.viewportOwner != nil {
		message.ViewportOwnerClientID = session.viewportOwner.id
	}
	return message
}

// broadcastViewportStateLocked queues while holding session.mu so concurrent changes reach
// every client in the order they were applied.
func (session *liveSession) broadcastViewportStateLocked() {
	for _, client := range session.clients {
		if client.autoSizeAware {
			client.queueStateUpdate(session.viewportStateLocked(client))
		}
	}
}
