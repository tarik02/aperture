package browser

import (
	"context"
	"errors"
	"sort"
	"time"
)

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

func (session *liveSession) updateCursor(client *liveSessionClient, targetID string, x, y float64) error {
	if targetID == "" || x < 0 || x > 1 || y < 0 || y > 1 {
		return errors.New("cursor position is invalid")
	}
	message := liveSessionServerMessage{Type: "presence.cursor", ClientID: client.id, TargetID: targetID, X: &x, Y: &y}
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
	message := liveSessionServerMessage{Type: "presence.cursor.clear", ClientID: client.id}
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
	session.mu.Lock()
	if session.clients[client.id] != client {
		session.mu.Unlock()
		return errors.New("session client is unavailable")
	}
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
	message := liveSessionServerMessage{Type: "presence.state", Participants: participants}
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
