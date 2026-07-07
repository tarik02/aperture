package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	maxQueuedInputMessages = 256
	viewportResizeCoalesce = 32 * time.Millisecond
)

type webRTCProducerConfig struct {
	sessionID      string
	gstExecutable  string
	pluginPath     string
	target         string
	targetName     string
	compositorPID  int
	width          int
	height         int
	scale          float64
	physicalWidth  int
	physicalHeight int
	iceServers     []webrtc.ICEServer
	codec          string
	fps            int
	bitrateKbps    int
	keyframe       int
	controlSocket  string
}

type signalEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type producer struct {
	cfg              webRTCProducerConfig
	out              chan []byte
	mu               sync.Mutex
	peer             *activePeer
	resizeMu         sync.Mutex
	pendingResize    viewportResizeRequest
	hasPendingResize bool
	resizeScheduled  bool
	resizeInFlight   bool
}

type viewportResizeRequest struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

type streamSettingsRequest struct {
	FPS              int `json:"fps"`
	BitrateKbps      int `json:"bitrateKbps"`
	KeyframeInterval int `json:"keyframeInterval"`
}

type activePeer struct {
	ctx           context.Context
	cancel        context.CancelFunc
	pc            *webrtc.PeerConnection
	udp           net.PacketConn
	track         *webrtc.TrackLocalStaticRTP
	rtpPort       int
	mediaMu       sync.Mutex
	gst           *exec.Cmd
	gstDone       <-chan error
	mediaErr      error
	mediaGen      int
	suppressGen   int
	rtpOnce       sync.Once
	rtpMu         sync.Mutex
	rtpStarted    bool
	rtpSeq        uint16
	rtpSSRC       uint32
	rtpInputTS    uint32
	rtpOutputTS   uint32
	streamingOnce sync.Once
	input         inputClient
	inputOnce     sync.Once
	inputMu       sync.Mutex
	inputQueue    [][]byte
	inputMove     []byte
	inputSignal   chan struct{}
	iceMu         sync.Mutex
	pendingICE    []webrtc.ICECandidateInit
}

func newWebRTCProducer(values RuntimeEnvValues, controlSocket string, targetName string, compositorPID int) (*producer, error) {
	iceServers, err := parseICEServers(values.MediaProducerICEServers)
	if err != nil {
		return nil, err
	}
	cfg := webRTCProducerConfig{
		sessionID:      values.SessionID,
		gstExecutable:  values.MediaProducerGSTExecutable,
		pluginPath:     values.MediaProducerPluginPath,
		target:         values.MediaProducerTarget,
		targetName:     targetName,
		compositorPID:  compositorPID,
		width:          values.CompositorWidth,
		height:         values.CompositorHeight,
		scale:          1,
		physicalWidth:  values.CompositorWidth,
		physicalHeight: values.CompositorHeight,
		iceServers:     iceServers,
		codec:          normalizeCodec(values.MediaProducerCodec),
		fps:            values.MediaProducerFPS,
		bitrateKbps:    values.MediaProducerBitrateKbps,
		keyframe:       values.MediaProducerKeyframe,
		controlSocket:  controlSocket,
	}
	switch cfg.codec {
	case "vp8", "h264-va":
	default:
		return nil, fmt.Errorf("media producer codec must be vp8 or h264-va")
	}
	return &producer{cfg: cfg, out: make(chan []byte, 32)}, nil
}

func parseICEServers(raw string) ([]webrtc.ICEServer, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var servers []webrtc.ICEServer
	if err := json.Unmarshal([]byte(raw), &servers); err != nil {
		return nil, fmt.Errorf("parse WEBRTC_MEDIA_PRODUCER_ICE_SERVERS: %w", err)
	}
	return servers, nil
}

func normalizeCodec(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "vp8":
		return "vp8"
	case "h264", "h264-va":
		return "h264-va"
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func (p *producer) announceState() {
	p.enqueue("viewport-metadata", viewportMetadata(p.viewport()))
	p.enqueue("stream-settings", p.streamSettings())

	p.mu.Lock()
	ap := p.peer
	p.mu.Unlock()
	if ap == nil {
		p.enqueue("producer-health", map[string]any{"status": "idle"})
		return
	}
	if ap.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
		p.enqueue("producer-health", map[string]any{"status": "connected"})
		ap.mediaMu.Lock()
		streaming := ap.gst != nil && ap.mediaErr == nil
		ap.mediaMu.Unlock()
		if streaming {
			p.enqueue("producer-health", map[string]any{"status": "streaming"})
		}
		return
	}
	p.enqueue("producer-health", map[string]any{"status": "starting"})
}

func (p *producer) resumePeer() bool {
	p.mu.Lock()
	ap := p.peer
	p.mu.Unlock()
	if ap == nil || ap.ctx.Err() != nil {
		return false
	}
	switch ap.pc.ConnectionState() {
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
		return false
	}
	return true
}

func (p *producer) dropQueuedSignals() {
	for {
		select {
		case <-p.out:
		default:
			return
		}
	}
}

func (p *producer) handleViewerSignalMessage(ctx context.Context, body []byte) error {
	var msg signalEnvelope
	if err := json.Unmarshal(body, &msg); err != nil {
		return fmt.Errorf("decode signaling message: %w", err)
	}
	switch msg.Type {
	case "viewer-ready":
		if p.resumePeer() {
			return nil
		}
		if err := p.startPeer(ctx); err != nil {
			p.reportFailure("peer_start_failed", err)
		}
	case "sdp-answer":
		if err := p.setAnswer(msg.Payload); err != nil {
			p.reportFailure("sdp_answer_rejected", err)
			p.stopPeer()
		}
	case "ice-candidate":
		if err := p.addCandidate(msg.Payload); err != nil {
			p.reportFailure("ice_candidate_rejected", err)
		}
	case "viewer-health":
		if message, failed := viewerFailed(msg.Payload); failed {
			if message == "" {
				message = "viewer reported WebRTC failure"
			}
			fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: viewer failed: %s\n", message)
			p.stopPeer()
		}
	case "viewport-resize":
		if err := p.queueViewportResize(ctx, msg.Payload); err != nil {
			p.reportResizeFailure(err)
		}
	case "stream-settings":
		if err := p.applyStreamSettings(msg.Payload); err != nil {
			p.reportFailure("stream_settings_failed", err)
		}
	default:
		return fmt.Errorf("unexpected viewer signal message %q", msg.Type)
	}
	return nil
}

func viewerFailed(payload json.RawMessage) (string, bool) {
	var values struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(payload, &values); err != nil {
		return "", false
	}
	return values.Message, values.Status == "failed"
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

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: p.cfg.iceServers})
	if err != nil {
		_ = udp.Close()
		return fmt.Errorf("create peer connection: %w", err)
	}

	codecCapability := rtpCodecCapability(p.cfg.codec)
	track, err := webrtc.NewTrackLocalStaticRTP(codecCapability, "viewport", p.cfg.sessionID)
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
	input, err := newInputClient(p.cfg)
	if err != nil {
		_ = pc.Close()
		_ = udp.Close()
		return err
	}
	inputChannel, err := pc.CreateDataChannel("input", nil)
	if err != nil {
		_ = input.Close()
		_ = pc.Close()
		_ = udp.Close()
		return fmt.Errorf("create input data channel: %w", err)
	}

	peerCtx, cancel := context.WithCancel(ctx)
	ap := &activePeer{
		ctx:         peerCtx,
		cancel:      cancel,
		pc:          pc,
		udp:         udp,
		input:       input,
		inputSignal: make(chan struct{}, 1),
	}
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
			fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: local ICE candidate %s\n", candidateInit.Candidate)
			candidateMu.Lock()
			if !offerSent {
				pendingCandidates = append(pendingCandidates, candidateInit)
				candidateMu.Unlock()
				return
			}
			candidateMu.Unlock()
			if err := p.send(ap.ctx, "ice-candidate", candidateInit); err != nil {
				p.reportFailure("signal_send_failed", err)
			}
		}
	})
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: ICE connection state %s\n", state.String())
	})
	pc.OnICEGatheringStateChange(func(state webrtc.ICEGatheringState) {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: ICE gathering state %s\n", state.String())
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
			return
		}
		switch state {
		case webrtc.PeerConnectionStateConnected:
			p.enqueue("producer-health", map[string]any{"status": "connected"})
			if err := p.startMedia(ap); err != nil {
				if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
					return
				}
				p.reportFailure("media_start_failed", err)
				go p.stopActivePeer(ap)
			}
		case webrtc.PeerConnectionStateFailed:
			if ap.ctx.Err() != nil {
				return
			}
			p.reportFailure("peer_connection_failed", errors.New("peer connection failed"))
			go p.stopActivePeer(ap)
		case webrtc.PeerConnectionStateClosed:
			if ap.ctx.Err() == nil {
				go p.stopActivePeer(ap)
			}
		}
	})
	inputChannel.OnOpen(func() {
		if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
			return
		}
		p.enqueue("producer-health", map[string]any{"status": "input-channel-open"})
		go func() {
			if err := ap.input.Connect(ap.ctx); err != nil {
				if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
					return
				}
				p.reportInputFailure(ap, "input_connect_failed", err)
				return
			}
			p.enqueue("producer-health", map[string]any{"status": "input-connected"})
		}()
	})
	inputChannel.OnClose(func() {
		if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
			return
		}
		p.enqueue("producer-health", map[string]any{"status": "input-channel-closed"})
	})
	inputChannel.OnMessage(func(message webrtc.DataChannelMessage) {
		if response, ok := inputPingResponse(message.Data); ok {
			if err := inputChannel.Send(response); err != nil {
				p.reportInputFailure(ap, "input_ping_failed", err)
			}
			return
		}
		if err := p.queueInput(ap, message.Data); err != nil {
			p.reportInputFailure(ap, "input_queue_failed", err)
		}
	})

	port := udp.LocalAddr().(*net.UDPAddr).Port
	ap.track = track
	ap.rtpPort = port

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

	go p.runInput(ap)

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("set local description: %w", err)
	}

	if err := p.send(ap.ctx, "viewport-metadata", viewportMetadata(p.viewport())); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("send viewport metadata: %w", err)
	}
	if err := p.send(ap.ctx, "stream-settings", p.streamSettings()); err != nil {
		p.stopActivePeer(ap)
		return fmt.Errorf("send stream settings: %w", err)
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
	state := ap.pc.SignalingState()
	if state == webrtc.SignalingStateStable {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: stale SDP answer ignored in signaling state %s\n", state.String())
		return nil
	}
	if state != webrtc.SignalingStateHaveLocalOffer {
		return fmt.Errorf("unexpected SDP answer signaling state %s", state.String())
	}
	if err := ap.pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("set remote answer: %w", err)
	}
	ap.iceMu.Lock()
	candidates := append([]webrtc.ICECandidateInit(nil), ap.pendingICE...)
	ap.pendingICE = nil
	ap.iceMu.Unlock()
	for _, candidate := range candidates {
		if err := ap.pc.AddICECandidate(candidate); err != nil {
			return fmt.Errorf("add queued ICE candidate: %w", err)
		}
	}
	return nil
}

func (p *producer) startMedia(ap *activePeer) error {
	if ap == nil {
		return nil
	}
	ap.mediaMu.Lock()
	defer ap.mediaMu.Unlock()
	if ap.gst != nil {
		return ap.mediaErr
	}
	return p.startMediaLocked(ap)
}

func (p *producer) restartMedia(ap *activePeer) error {
	if ap == nil {
		return nil
	}
	ap.mediaMu.Lock()
	defer ap.mediaMu.Unlock()
	if ap.gst != nil && ap.gst.Process != nil {
		ap.suppressGen = ap.mediaGen
		_ = ap.gst.Process.Kill()
	}
	ap.gst = nil
	ap.gstDone = nil
	ap.mediaErr = nil
	return p.startMediaLocked(ap)
}

func (p *producer) startMediaLocked(ap *activePeer) error {
	if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
		ap.mediaErr = ap.ctx.Err()
		return ap.mediaErr
	}
	cfg, err := p.mediaConfig(ap.ctx)
	if err != nil {
		ap.mediaErr = err
		return ap.mediaErr
	}
	if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
		ap.mediaErr = ap.ctx.Err()
		return ap.mediaErr
	}
	gst, gstDone, err := startGStreamer(ap.ctx, cfg, ap.rtpPort)
	if err != nil {
		ap.mediaErr = err
		return ap.mediaErr
	}
	ap.mediaGen++
	gen := ap.mediaGen
	ap.gst = gst
	ap.gstDone = gstDone
	ap.rtpOnce.Do(func() {
		go p.forwardRTP(ap, ap.track)
	})
	go p.watchGStreamer(ap, gen, gstDone)
	return nil
}

func (p *producer) mediaConfig(ctx context.Context) (webRTCProducerConfig, error) {
	p.mu.Lock()
	cfg := p.cfg
	p.mu.Unlock()
	if cfg.targetName == "" || cfg.compositorPID == 0 {
		return cfg, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		target, err := ResolvePipeWireNodeTarget(cfg.targetName, cfg.compositorPID)
		if err == nil {
			cfg.target = target
			p.mu.Lock()
			p.cfg.target = target
			p.mu.Unlock()
			fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: resolved PipeWire target %s for compositor pid %d\n", target, cfg.compositorPID)
			return cfg, nil
		}
		lastErr = err

		select {
		case <-ctx.Done():
			return webRTCProducerConfig{}, fmt.Errorf("resolve PipeWire target: %w: %w", ctx.Err(), lastErr)
		case <-ticker.C:
		}
	}
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
	if ap.pc.RemoteDescription() == nil {
		ap.iceMu.Lock()
		ap.pendingICE = append(ap.pendingICE, candidate)
		ap.iceMu.Unlock()
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
				p.reportFailure("rtp_read_failed", err)
				go p.stopActivePeer(ap)
			}
			return
		}
		body, err := ap.rewriteRTP(buf[:n])
		if err != nil {
			p.reportFailure("rtp_rewrite_failed", err)
			go p.stopActivePeer(ap)
			return
		}
		if _, err := track.Write(body); err != nil {
			if errors.Is(err, io.ErrClosedPipe) || ap.ctx.Err() != nil {
				return
			}
			p.reportFailure("rtp_write_failed", err)
			go p.stopActivePeer(ap)
			return
		}
		ap.streamingOnce.Do(func() {
			p.enqueue("producer-health", map[string]any{"status": "streaming"})
		})
	}
}

func (ap *activePeer) rewriteRTP(body []byte) ([]byte, error) {
	var packet rtp.Packet
	if err := packet.Unmarshal(body); err != nil {
		return nil, err
	}

	ap.rtpMu.Lock()
	defer ap.rtpMu.Unlock()
	if !ap.rtpStarted {
		ap.rtpStarted = true
		ap.rtpSeq = packet.SequenceNumber
		ap.rtpSSRC = packet.SSRC
		ap.rtpInputTS = packet.Timestamp
		ap.rtpOutputTS = packet.Timestamp
	} else {
		ap.rtpSeq++
		if packet.Timestamp != ap.rtpInputTS {
			delta := packet.Timestamp - ap.rtpInputTS
			if delta > 450000 {
				delta = 3000
			}
			ap.rtpInputTS = packet.Timestamp
			ap.rtpOutputTS += delta
		}
	}
	packet.SequenceNumber = ap.rtpSeq
	packet.SSRC = ap.rtpSSRC
	packet.Timestamp = ap.rtpOutputTS
	return packet.Marshal()
}

func (p *producer) watchGStreamer(ap *activePeer, gen int, gstDone <-chan error) {
	select {
	case err := <-gstDone:
		if ap.ctx.Err() != nil {
			return
		}
		ap.mediaMu.Lock()
		if ap.suppressGen == gen {
			ap.suppressGen = 0
			ap.mediaMu.Unlock()
			return
		}
		ap.mediaMu.Unlock()
		if err != nil {
			p.reportFailure("gstreamer_failed", err)
		} else {
			p.reportFailure("gstreamer_exited", errors.New("gstreamer exited"))
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

func (p *producer) isActivePeer(ap *activePeer) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.peer == ap
}

func (p *producer) queueInput(ap *activePeer, body []byte) error {
	if ap == nil {
		return nil
	}
	next := append([]byte(nil), body...)

	ap.inputMu.Lock()
	if inputMessageIsMouseMove(next) {
		ap.inputMove = next
	} else {
		if ap.inputMove != nil {
			if len(ap.inputQueue) >= maxQueuedInputMessages {
				ap.inputMu.Unlock()
				return fmt.Errorf("input queue is full")
			}
			ap.inputQueue = append(ap.inputQueue, ap.inputMove)
			ap.inputMove = nil
		}
		if len(ap.inputQueue) >= maxQueuedInputMessages {
			ap.inputMu.Unlock()
			return fmt.Errorf("input queue is full")
		}
		ap.inputQueue = append(ap.inputQueue, next)
	}
	ap.inputMu.Unlock()

	select {
	case ap.inputSignal <- struct{}{}:
	default:
	}
	return nil
}

func inputMessageIsMouseMove(body []byte) bool {
	var msg struct {
		Type   string `json:"type"`
		Action string `json:"action"`
	}
	if err := json.Unmarshal(body, &msg); err != nil {
		return false
	}
	return msg.Type == "input.mouse" && msg.Action == "move"
}

func (p *producer) runInput(ap *activePeer) {
	for {
		select {
		case <-ap.ctx.Done():
			return
		case <-ap.inputSignal:
			for {
				body := ap.nextInput()
				if body == nil {
					break
				}
				started := time.Now()
				if err := ap.input.HandleJSON(ap.ctx, body); err != nil {
					if !p.isActivePeer(ap) || ap.ctx.Err() != nil {
						return
					}
					p.reportInputFailure(ap, "input_dispatch_failed", err)
					continue
				}
				if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
					fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: slow input dispatch: %s\n", elapsed)
				}
			}
		}
	}
}

func (ap *activePeer) nextInput() []byte {
	ap.inputMu.Lock()
	defer ap.inputMu.Unlock()

	if len(ap.inputQueue) > 0 {
		body := ap.inputQueue[0]
		copy(ap.inputQueue, ap.inputQueue[1:])
		ap.inputQueue[len(ap.inputQueue)-1] = nil
		ap.inputQueue = ap.inputQueue[:len(ap.inputQueue)-1]
		return body
	}
	if ap.inputMove != nil {
		body := ap.inputMove
		ap.inputMove = nil
		return body
	}
	return nil
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
	ap.mediaMu.Lock()
	if ap.gst != nil && ap.gst.Process != nil {
		_ = ap.gst.Process.Kill()
	}
	ap.mediaMu.Unlock()
	if ap.input != nil {
		_ = ap.input.Close()
	}
	_ = ap.udp.Close()
	_ = ap.pc.Close()
	p.enqueue("producer-health", map[string]any{"status": "idle"})
}

func startGStreamer(ctx context.Context, cfg webRTCProducerConfig, port int) (*exec.Cmd, <-chan error, error) {
	keepaliveMS := 1000 / cfg.fps
	args := []string{
		"pipewiresrc",
		"target-object=" + cfg.target,
		"do-timestamp=true",
		"keepalive-time=" + strconv.Itoa(keepaliveMS),
		"!",
		"queue",
		"max-size-buffers=1",
		"leaky=downstream",
		"!",
		"videorate",
		"drop-only=true",
		"!",
		fmt.Sprintf("video/x-raw,framerate=%d/1", cfg.fps),
		"!",
		"queue",
		"max-size-buffers=1",
		"leaky=downstream",
		"!",
	}
	args = append(args, encoderPipeline(cfg)...)
	args = append(args,
		"!",
		"udpsink",
		"host=127.0.0.1",
		fmt.Sprintf("port=%d", port),
		"sync=false",
		"async=false",
	)
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

func (p *producer) viewport() compositorViewport {
	p.mu.Lock()
	defer p.mu.Unlock()
	return compositorViewport{
		Width:             p.cfg.width,
		Height:            p.cfg.height,
		DeviceScaleFactor: p.cfg.scale,
		ScaleNumerator:    viewportScaleNumerator(p.cfg.scale),
		PhysicalWidth:     p.cfg.physicalWidth,
		PhysicalHeight:    p.cfg.physicalHeight,
	}
}

func (p *producer) setViewport(viewport compositorViewport) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cfg.width = viewport.Width
	p.cfg.height = viewport.Height
	p.cfg.scale = viewport.DeviceScaleFactor
	p.cfg.physicalWidth = viewport.PhysicalWidth
	p.cfg.physicalHeight = viewport.PhysicalHeight
}

func (p *producer) queueViewportResize(ctx context.Context, payload json.RawMessage) error {
	var request viewportResizeRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return fmt.Errorf("decode viewport resize: %w", err)
	}
	if request.Width <= 0 || request.Height <= 0 || request.Width > 16384 || request.Height > 16384 {
		return fmt.Errorf("invalid viewport resize %dx%d", request.Width, request.Height)
	}

	p.resizeMu.Lock()
	p.pendingResize = request
	p.hasPendingResize = true
	if p.resizeScheduled || p.resizeInFlight {
		p.resizeMu.Unlock()
		return nil
	}
	p.resizeScheduled = true
	p.resizeMu.Unlock()

	time.AfterFunc(viewportResizeCoalesce, func() {
		p.flushViewportResize(ctx)
	})
	return nil
}

func (p *producer) flushViewportResize(ctx context.Context) {
	p.resizeMu.Lock()
	if !p.hasPendingResize {
		p.resizeScheduled = false
		p.resizeMu.Unlock()
		return
	}
	request := p.pendingResize
	p.hasPendingResize = false
	p.resizeScheduled = false
	p.resizeInFlight = true
	p.resizeMu.Unlock()

	if ctx.Err() == nil {
		if err := p.resizeViewport(ctx, request); err != nil {
			p.reportResizeFailure(err)
		}
	}

	p.resizeMu.Lock()
	p.resizeInFlight = false
	shouldSchedule := p.hasPendingResize && !p.resizeScheduled
	if shouldSchedule {
		p.resizeScheduled = true
	}
	p.resizeMu.Unlock()

	if shouldSchedule {
		time.AfterFunc(viewportResizeCoalesce, func() {
			p.flushViewportResize(ctx)
		})
	}
}

func (p *producer) resizeViewport(ctx context.Context, request viewportResizeRequest) error {
	viewport, err := resizeCompositor(ctx, p.cfg.controlSocket, request.Width, request.Height, request.DeviceScaleFactor)
	if err != nil {
		return err
	}
	p.setViewport(viewport)
	p.enqueue("viewport-metadata", viewportMetadata(viewport))
	return nil
}

func (p *producer) applyStreamSettings(payload json.RawMessage) error {
	var request streamSettingsRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return fmt.Errorf("decode stream settings: %w", err)
	}
	if err := validateStreamSettings(request); err != nil {
		return err
	}

	p.mu.Lock()
	changed := p.cfg.fps != request.FPS ||
		p.cfg.bitrateKbps != request.BitrateKbps ||
		p.cfg.keyframe != request.KeyframeInterval
	p.cfg.fps = request.FPS
	p.cfg.bitrateKbps = request.BitrateKbps
	p.cfg.keyframe = request.KeyframeInterval
	ap := p.peer
	p.mu.Unlock()

	if changed && ap != nil {
		if err := p.restartMedia(ap); err != nil {
			return err
		}
	}
	p.enqueue("stream-settings", p.streamSettings())
	return nil
}

func validateStreamSettings(settings streamSettingsRequest) error {
	if settings.FPS < 1 || settings.FPS > 120 {
		return fmt.Errorf("stream settings fps must be between 1 and 120")
	}
	if settings.BitrateKbps < 1 || settings.BitrateKbps > 50000 {
		return fmt.Errorf("stream settings bitrate must be between 1 and 50000 kbps")
	}
	if settings.KeyframeInterval < 1 || settings.KeyframeInterval > 600 {
		return fmt.Errorf("stream settings keyframe interval must be between 1 and 600")
	}
	return nil
}

func (p *producer) streamSettings() streamSettingsRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return streamSettingsRequest{
		FPS:              p.cfg.fps,
		BitrateKbps:      p.cfg.bitrateKbps,
		KeyframeInterval: p.cfg.keyframe,
	}
}

func encoderPipeline(cfg webRTCProducerConfig) []string {
	switch cfg.codec {
	case "h264-va":
		return []string{
			"vapostproc",
			"!",
			"video/x-raw(memory:VAMemory),format=NV12",
			"!",
			"vah264enc",
			"bitrate=" + strconv.Itoa(cfg.bitrateKbps),
			"rate-control=vcm",
			"key-int-max=" + strconv.Itoa(cfg.keyframe),
			"target-usage=7",
			"ref-frames=1",
			"cabac=false",
			"!",
			"h264parse",
			"!",
			"rtph264pay",
			"pt=96",
			"aggregate-mode=zero-latency",
			"config-interval=-1",
		}
	default:
		return []string{
			"videoconvert",
			"!",
			"vp8enc",
			"deadline=1",
			"keyframe-max-dist=" + strconv.Itoa(cfg.keyframe),
			"cpu-used=8",
			"target-bitrate=" + strconv.Itoa(cfg.bitrateKbps*1000),
			"!",
			"rtpvp8pay",
			"pt=96",
			"picture-id-mode=15-bit",
		}
	}
}

func rtpCodecCapability(codec string) webrtc.RTPCodecCapability {
	switch codec {
	case "h264-va":
		return webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeH264,
			ClockRate:    90000,
			SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
			RTCPFeedback: nil,
		}
	default:
		return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}
	}
}

func mediaProcessEnv(pluginPath string) []string {
	env := make([]string, 0, 4)
	for _, key := range []string{"XDG_RUNTIME_DIR", "PIPEWIRE_REMOTE", "DBUS_SESSION_BUS_ADDRESS", "LIBVA_DRIVER_NAME", "NVIDIA_VISIBLE_DEVICES"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			env = append(env, key+"="+value)
		}
	}
	if strings.TrimSpace(pluginPath) != "" {
		env = append(env, "GST_PLUGIN_SYSTEM_PATH_1_0="+pluginPath)
	}
	return env
}

func (p *producer) reportFailure(code string, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: %s: %v\n", code, err)
	}
	payload := map[string]any{"status": "failed", "code": code}
	if err != nil {
		payload["message"] = err.Error()
	}
	p.enqueue("producer-health", payload)
}

func (p *producer) reportInputFailure(ap *activePeer, code string, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: %s: %v\n", code, err)
	}
	if ap == nil {
		return
	}
	ap.inputOnce.Do(func() {
		payload := map[string]any{"status": "input-failed", "code": code}
		if err != nil {
			payload["message"] = err.Error()
		}
		p.enqueue("producer-health", payload)
	})
}

func (p *producer) reportResizeFailure(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: viewport_resize_failed: %v\n", err)
	}
	payload := map[string]any{"status": "resize-failed", "code": "viewport_resize_failed"}
	if err != nil {
		payload["message"] = err.Error()
	}
	p.enqueue("producer-health", payload)
}

func (p *producer) enqueue(messageType string, payload any) {
	body, err := encodeSignalMessage(messageType, payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: encode %s message: %v\n", messageType, err)
		return
	}
	select {
	case p.out <- body:
	default:
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: signaling queue full, dropping %s\n", messageType)
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
