package browser

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	rtc "github.com/tarik02/webdesktop/webrtc"
)

const liveSessionWebRTCHelloTimeout = 5 * time.Second

type liveSessionWebRTCPeerMetadata struct {
	session                   *liveSession
	role                      string
	capabilityRole            string
	sessionTokenAuthenticated bool
	cancel                    context.CancelFunc
	service                   *rtc.Service

	mu        sync.Mutex
	transport *liveSessionWebRTCTransport
}

type liveSessionWebRTCTransport struct {
	metadata *liveSessionWebRTCPeerMetadata
	service  *rtc.Service
	peerID   uint64

	mu            sync.Mutex
	reliableOpen  bool
	realtimeOpen  bool
	helloReceived bool
	helloTimer    *time.Timer
	client        *liveSessionClient
}

type liveSessionWebRTCApplicationHandler struct {
	session *liveSession
}

func (handler *liveSessionWebRTCApplicationHandler) ApplicationChannelOpened(peer rtc.PeerInfo, channel rtc.ApplicationChannel) {
	transport := handler.transport(peer)
	if transport == nil {
		return
	}
	transport.mu.Lock()
	switch channel {
	case rtc.ApplicationChannelReliable:
		transport.reliableOpen = true
	case rtc.ApplicationChannelRealtime:
		transport.realtimeOpen = true
	}
	transport.mu.Unlock()
}

func (handler *liveSessionWebRTCApplicationHandler) ApplicationMessageReceived(peer rtc.PeerInfo, channel rtc.ApplicationChannel, applicationMessage rtc.ApplicationMessage) {
	if !applicationMessage.IsString {
		return
	}
	transport := handler.transport(peer)
	if transport == nil {
		return
	}
	message, err := decodeLiveSessionMessage(applicationMessage.Data)
	if err != nil {
		return
	}
	transport.mu.Lock()
	client := transport.client
	reliableOpen := transport.reliableOpen
	realtimeOpen := transport.realtimeOpen
	if client == nil {
		if channel != rtc.ApplicationChannelReliable || message.Type != "session.hello" || !reliableOpen || !realtimeOpen || transport.helloReceived {
			transport.mu.Unlock()
			return
		}
		transport.helloReceived = true
		transport.helloTimer.Stop()
		transport.mu.Unlock()
		_, err = handler.session.attachWebRTCClient(transport, message)
		if err != nil {
			transport.close(err.Error())
			return
		}
		return
	}
	transport.mu.Unlock()
	delivery := liveSessionDeliveryReliable
	if channel == rtc.ApplicationChannelRealtime {
		delivery = liveSessionDeliveryRealtime
	}
	handler.session.handleSessionMessage(client, transport, message, delivery)
}

func (handler *liveSessionWebRTCApplicationHandler) ApplicationChannelClosed(peer rtc.PeerInfo, channel rtc.ApplicationChannel) {
	transport := handler.transport(peer)
	if transport == nil {
		return
	}
	transport.mu.Lock()
	switch channel {
	case rtc.ApplicationChannelReliable:
		transport.reliableOpen = false
	case rtc.ApplicationChannelRealtime:
		transport.realtimeOpen = false
	}
	client := transport.client
	transport.mu.Unlock()
	if client != nil {
		handler.session.detachClientTransport(client, transport)
	}
}

func (handler *liveSessionWebRTCApplicationHandler) transport(peer rtc.PeerInfo) *liveSessionWebRTCTransport {
	metadata, ok := peer.Metadata.(*liveSessionWebRTCPeerMetadata)
	if !ok || metadata == nil || metadata.session != handler.session {
		return nil
	}
	metadata.mu.Lock()
	defer metadata.mu.Unlock()
	if metadata.transport == nil {
		transport := &liveSessionWebRTCTransport{
			metadata: metadata,
			service:  metadata.service,
			peerID:   peer.ID,
		}
		transport.helloTimer = time.AfterFunc(liveSessionWebRTCHelloTimeout, func() {
			transport.mu.Lock()
			pending := !transport.helloReceived && transport.client == nil
			transport.mu.Unlock()
			if pending {
				transport.close("session hello timed out")
			}
		})
		metadata.transport = transport
	}
	return metadata.transport
}

func (session *liveSession) attachWebRTCClient(transport *liveSessionWebRTCTransport, hello liveSessionClientMessage) (*liveSessionClient, error) {
	metadata := transport.metadata
	if hello.ClientID == "" && hello.ResumeSecret == "" {
		name := strings.TrimSpace(hello.Name)
		if !validLiveSessionName(name) || !validLiveSessionAvatarHash(hello.AvatarHash) {
			return nil, errors.New("session identity is invalid")
		}
		secret, err := newLiveSessionResumeSecret()
		if err != nil {
			return nil, err
		}
		client, err := session.addClient(
			uuid.NewString(),
			metadata.role,
			name,
			hello.AvatarHash,
			metadata.capabilityRole,
			metadata.sessionTokenAuthenticated,
		)
		if err != nil {
			return nil, err
		}
		client.resumeSecret = secret
		transport.mu.Lock()
		transport.client = client
		transport.mu.Unlock()
		if err := session.activateTransport(client, transport, nil); err != nil {
			transport.mu.Lock()
			transport.client = nil
			transport.mu.Unlock()
			session.removeClient(client)
			return nil, err
		}
		return client, nil
	}
	if !validLiveSessionClientID(hello.ClientID) || hello.ResumeSecret == "" {
		return nil, errors.New("session resume credentials are invalid")
	}
	session.mu.Lock()
	client := session.clients[hello.ClientID]
	if client == nil || client.resumeSecret != hello.ResumeSecret || client.role != metadata.role {
		session.mu.Unlock()
		return nil, errors.New("session resume credentials are invalid")
	}
	client.capabilityRole = metadata.capabilityRole
	client.sessionTokenAuthenticated = metadata.sessionTokenAuthenticated
	session.mu.Unlock()
	previous := client.transport()
	transport.mu.Lock()
	transport.client = client
	transport.mu.Unlock()
	if err := session.activateTransport(client, transport, previous); err != nil {
		transport.mu.Lock()
		transport.client = nil
		transport.mu.Unlock()
		return nil, err
	}
	return client, nil
}

func (transport *liveSessionWebRTCTransport) kind() string { return "webrtc" }

func (transport *liveSessionWebRTCTransport) send(delivery liveSessionDelivery, body []byte) error {
	channel := rtc.ApplicationChannelReliable
	if delivery == liveSessionDeliveryRealtime {
		channel = rtc.ApplicationChannelRealtime
	}
	return transport.service.SendApplication(transport.peerID, channel, rtc.ApplicationMessage{
		Data:     body,
		IsString: true,
	})
}

func (transport *liveSessionWebRTCTransport) selectTarget(targetID string) error {
	ctx, cancel := context.WithTimeout(transport.metadata.session.runtime.ctx, liveSessionBrowserCommandTimeout)
	defer cancel()
	_, err := transport.service.SelectTarget(ctx, transport.peerID, targetID)
	return err
}

func (transport *liveSessionWebRTCTransport) close(string) {
	transport.metadata.cancel()
}

func newLiveSessionWebRTCPeerMetadata(session *liveSession, service *rtc.Service, req *http.Request, cancel context.CancelFunc) *liveSessionWebRTCPeerMetadata {
	return &liveSessionWebRTCPeerMetadata{
		session:                   session,
		role:                      strings.TrimSpace(req.Header.Get("X-Aperture-Collaboration-Role")),
		capabilityRole:            collaborationCapabilityRole(req),
		sessionTokenAuthenticated: sessionTokenAuthenticated(req),
		cancel:                    cancel,
		service:                   service,
	}
}
