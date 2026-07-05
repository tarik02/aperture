package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	signalProtocol = "aperture-webrtc.v1"
	maxSignalBytes = 64 << 10
)

type config struct {
	sessionID     string
	signalURL     string
	token         string
	gstExecutable string
	pluginPath    string
	target        string
	width         int
	height        int
}

type signalEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type producer struct {
	cfg  config
	out  chan []byte
	mu   sync.Mutex
	peer *activePeer
}

type activePeer struct {
	ctx           context.Context
	cancel        context.CancelFunc
	pc            *webrtc.PeerConnection
	udp           net.PacketConn
	gst           *exec.Cmd
	gstDone       <-chan error
	streamingOnce sync.Once
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "webrtc-media-producer: %v\n", err)
		os.Exit(1)
	}

	if err := run(ctx, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "webrtc-media-producer: %v\n", err)
		os.Exit(1)
	}
}

func loadConfig() (config, error) {
	width, err := positiveIntEnv("WEBRTC_COMPOSITOR_WIDTH")
	if err != nil {
		return config{}, err
	}
	height, err := positiveIntEnv("WEBRTC_COMPOSITOR_HEIGHT")
	if err != nil {
		return config{}, err
	}

	cfg := config{
		sessionID:     strings.TrimSpace(os.Getenv("APERTURE_SESSION_ID")),
		signalURL:     strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_SIGNAL_URL")),
		token:         strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_TOKEN")),
		gstExecutable: strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_GST_EXECUTABLE")),
		pluginPath:    strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_PLUGIN_PATH")),
		target:        strings.TrimSpace(os.Getenv("WEBRTC_MEDIA_PRODUCER_TARGET")),
		width:         width,
		height:        height,
	}
	for name, value := range map[string]string{
		"APERTURE_SESSION_ID":                  cfg.sessionID,
		"WEBRTC_MEDIA_PRODUCER_SIGNAL_URL":     cfg.signalURL,
		"WEBRTC_MEDIA_PRODUCER_TOKEN":          cfg.token,
		"WEBRTC_MEDIA_PRODUCER_GST_EXECUTABLE": cfg.gstExecutable,
		"WEBRTC_MEDIA_PRODUCER_TARGET":         cfg.target,
	} {
		if value == "" {
			return config{}, fmt.Errorf("%s is required", name)
		}
	}
	return cfg, nil
}

func positiveIntEnv(name string) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be positive", name)
	}
	return value, nil
}

func run(ctx context.Context, cfg config) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, cfg.signalURL, &websocket.DialOptions{
		Subprotocols: []string{signalProtocol, "authorization.bearer." + cfg.token},
	})
	if err != nil {
		return fmt.Errorf("dial signaling: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(maxSignalBytes)

	p := &producer{cfg: cfg, out: make(chan []byte, 32)}
	writeDone := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writeDone <- ctx.Err()
				return
			case body := <-p.out:
				if err := conn.Write(ctx, websocket.MessageText, body); err != nil {
					cancel()
					writeDone <- err
					return
				}
			}
		}
	}()

	p.enqueue("producer-health", map[string]any{"status": "idle"})
	for {
		select {
		case err := <-writeDone:
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return fmt.Errorf("write signaling: %w", err)
		default:
		}

		messageType, body, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				return nil
			}
			return fmt.Errorf("read signaling: %w", err)
		}
		if messageType != websocket.MessageText {
			return fmt.Errorf("unexpected signaling message type %v", messageType)
		}

		var msg signalEnvelope
		if err := json.Unmarshal(body, &msg); err != nil {
			return fmt.Errorf("decode signaling message: %w", err)
		}
		switch msg.Type {
		case "viewer-ready":
			if err := p.startPeer(ctx); err != nil {
				p.enqueue("producer-health", map[string]any{"status": "failed", "code": "peer_start_failed"})
			}
		case "sdp-answer":
			if err := p.setAnswer(msg.Payload); err != nil {
				p.enqueue("producer-health", map[string]any{"status": "failed", "code": "sdp_answer_rejected"})
				p.stopPeer()
			}
		case "ice-candidate":
			if err := p.addCandidate(msg.Payload); err != nil {
				p.enqueue("producer-health", map[string]any{"status": "failed", "code": "ice_candidate_rejected"})
			}
		}
	}
}

func (p *producer) startPeer(ctx context.Context) error {
	p.stopPeer()
	p.enqueue("producer-health", map[string]any{"status": "starting"})

	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen rtp udp: %w", err)
	}
	if conn, ok := udp.(*net.UDPConn); ok {
		_ = conn.SetReadBuffer(300000)
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = udp.Close()
		return fmt.Errorf("create peer connection: %w", err)
	}

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"viewport",
		p.cfg.sessionID,
	)
	if err != nil {
		_ = pc.Close()
		_ = udp.Close()
		return fmt.Errorf("create video track: %w", err)
	}
	rtpSender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		_ = udp.Close()
		return fmt.Errorf("add video track: %w", err)
	}

	peerCtx, cancel := context.WithCancel(ctx)
	ap := &activePeer{ctx: peerCtx, cancel: cancel, pc: pc, udp: udp}
	var candidateMu sync.Mutex
	offerSent := false
	pendingCandidates := make([]webrtc.ICECandidateInit, 0, 4)

	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := rtpSender.Read(buf); err != nil {
				return
			}
		}
	}()

	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			candidateInit := candidate.ToJSON()
			candidateMu.Lock()
			if !offerSent {
				pendingCandidates = append(pendingCandidates, candidateInit)
				candidateMu.Unlock()
				return
			}
			candidateMu.Unlock()
			if err := p.send(ap.ctx, "ice-candidate", candidateInit); err != nil {
				p.enqueue("producer-health", map[string]any{"status": "failed", "code": "signal_send_failed"})
			}
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			p.enqueue("producer-health", map[string]any{"status": "connected"})
		case webrtc.PeerConnectionStateFailed:
			p.enqueue("producer-health", map[string]any{"status": "failed", "code": "peer_connection_failed"})
			go p.stopActivePeer(ap)
		case webrtc.PeerConnectionStateClosed:
			p.enqueue("producer-health", map[string]any{"status": "failed", "code": "peer_connection_closed"})
			go p.stopActivePeer(ap)
		}
	})

	port := udp.LocalAddr().(*net.UDPAddr).Port
	gst, gstDone, err := startGStreamer(peerCtx, p.cfg, port)
	if err != nil {
		cancel()
		_ = pc.Close()
		_ = udp.Close()
		return err
	}
	ap.gst = gst
	ap.gstDone = gstDone

	p.mu.Lock()
	if p.peer != nil {
		p.mu.Unlock()
		cancel()
		_ = pc.Close()
		_ = udp.Close()
		return nil
	}
	p.peer = ap
	p.mu.Unlock()

	go p.forwardRTP(ap, track)
	go p.watchGStreamer(ap)

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("set local description: %w", err)
	}

	if err := p.send(ap.ctx, "viewport-metadata", map[string]any{
		"width":  p.cfg.width,
		"height": p.cfg.height,
	}); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("send viewport metadata: %w", err)
	}
	if err := p.send(ap.ctx, "producer-health", map[string]any{"status": "negotiating"}); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("send negotiating health: %w", err)
	}
	if err := p.send(ap.ctx, "sdp-offer", pc.LocalDescription()); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("send offer: %w", err)
	}
	candidateMu.Lock()
	offerSent = true
	candidates := append([]webrtc.ICECandidateInit(nil), pendingCandidates...)
	pendingCandidates = nil
	candidateMu.Unlock()
	for _, candidate := range candidates {
		if err := p.send(ap.ctx, "ice-candidate", candidate); err != nil {
			p.stopActivePeer(ap)
			return fmt.Errorf("send queued ICE candidate: %w", err)
		}
	}
	return nil
}

func (p *producer) setAnswer(payload json.RawMessage) error {
	p.mu.Lock()
	ap := p.peer
	p.mu.Unlock()
	if ap == nil {
		return nil
	}

	var answer webrtc.SessionDescription
	if err := json.Unmarshal(payload, &answer); err != nil {
		return fmt.Errorf("decode answer: %w", err)
	}
	if answer.Type != webrtc.SDPTypeAnswer {
		return fmt.Errorf("unexpected SDP answer type %s", answer.Type.String())
	}
	if err := ap.pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("set remote answer: %w", err)
	}
	return nil
}

func (p *producer) addCandidate(payload json.RawMessage) error {
	p.mu.Lock()
	ap := p.peer
	p.mu.Unlock()
	if ap == nil {
		return nil
	}

	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal(payload, &candidate); err != nil {
		return fmt.Errorf("decode ICE candidate: %w", err)
	}
	if strings.TrimSpace(candidate.Candidate) == "" {
		return nil
	}
	if err := ap.pc.AddICECandidate(candidate); err != nil {
		return fmt.Errorf("add ICE candidate: %w", err)
	}
	return nil
}

func (p *producer) forwardRTP(ap *activePeer, track *webrtc.TrackLocalStaticRTP) {
	buf := make([]byte, 1600)
	for {
		n, _, err := ap.udp.ReadFrom(buf)
		if err != nil {
			if ap.ctx.Err() == nil {
				p.enqueue("producer-health", map[string]any{"status": "failed", "code": "rtp_read_failed"})
				go p.stopActivePeer(ap)
			}
			return
		}
		if _, err := track.Write(buf[:n]); err != nil {
			if errors.Is(err, io.ErrClosedPipe) || ap.ctx.Err() != nil {
				return
			}
			p.enqueue("producer-health", map[string]any{"status": "failed", "code": "rtp_write_failed"})
			go p.stopActivePeer(ap)
			return
		}
		ap.streamingOnce.Do(func() {
			p.enqueue("producer-health", map[string]any{"status": "streaming"})
		})
	}
}

func (p *producer) watchGStreamer(ap *activePeer) {
	select {
	case err := <-ap.gstDone:
		if ap.ctx.Err() != nil {
			return
		}
		if err != nil {
			p.enqueue("producer-health", map[string]any{"status": "failed", "code": "gstreamer_failed"})
		} else {
			p.enqueue("producer-health", map[string]any{"status": "failed", "code": "gstreamer_exited"})
		}
		p.stopActivePeer(ap)
	case <-ap.ctx.Done():
	}
}

func (p *producer) stopPeer() {
	p.mu.Lock()
	ap := p.peer
	p.mu.Unlock()
	if ap != nil {
		p.stopActivePeer(ap)
	}
}

func (p *producer) stopActivePeer(ap *activePeer) {
	p.mu.Lock()
	if p.peer != ap {
		p.mu.Unlock()
		return
	}
	p.peer = nil
	p.mu.Unlock()

	ap.cancel()
	_ = ap.udp.Close()
	_ = ap.pc.Close()
	p.enqueue("producer-health", map[string]any{"status": "idle"})
}

func startGStreamer(ctx context.Context, cfg config, port int) (*exec.Cmd, <-chan error, error) {
	args := []string{
		"pipewiresrc",
		"target-object=" + cfg.target,
		"do-timestamp=true",
		"!",
		fmt.Sprintf("video/x-raw,width=%d,height=%d", cfg.width, cfg.height),
		"!",
		"videoconvert",
		"!",
		"queue",
		"max-size-buffers=2",
		"leaky=downstream",
		"!",
		"vp8enc",
		"deadline=1",
		"keyframe-max-dist=30",
		"cpu-used=8",
		"!",
		"rtpvp8pay",
		"pt=96",
		"picture-id-mode=15-bit",
		"!",
		"udpsink",
		"host=127.0.0.1",
		fmt.Sprintf("port=%d", port),
		"sync=false",
		"async=false",
	}
	cmd := exec.CommandContext(ctx, cfg.gstExecutable, args...)
	cmd.Env = mediaProcessEnv(cfg.pluginPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start gstreamer: %w", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	return cmd, done, nil
}

func mediaProcessEnv(pluginPath string) []string {
	env := make([]string, 0, 4)
	for _, key := range []string{"XDG_RUNTIME_DIR", "PIPEWIRE_REMOTE", "DBUS_SESSION_BUS_ADDRESS"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			env = append(env, key+"="+value)
		}
	}
	if strings.TrimSpace(pluginPath) != "" {
		env = append(env, "GST_PLUGIN_SYSTEM_PATH_1_0="+pluginPath)
	}
	return env
}

func (p *producer) enqueue(messageType string, payload any) {
	body, err := encodeSignalMessage(messageType, payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "webrtc-media-producer: encode %s message: %v\n", messageType, err)
		return
	}
	select {
	case p.out <- body:
	default:
		fmt.Fprintf(os.Stderr, "webrtc-media-producer: signaling queue full, dropping %s\n", messageType)
	}
}

func (p *producer) send(ctx context.Context, messageType string, payload any) error {
	body, err := encodeSignalMessage(messageType, payload)
	if err != nil {
		return err
	}
	select {
	case p.out <- body:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func encodeSignalMessage(messageType string, payload any) ([]byte, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode payload: %w", err)
	}
	body, err := json.Marshal(signalEnvelope{Type: messageType, Payload: payloadBytes})
	if err != nil {
		return nil, fmt.Errorf("encode message: %w", err)
	}
	return body, nil
}
