package browser

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	remoteinput "github.com/tarik02/webdesktop/input"
)

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
	if previousClient, ok := previous.(*liveSessionClient); ok {
		clear(previousClient.pressedButtons)
		clear(previousClient.pressedKeys)
	}
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
