package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"

	webdesktopconfig "github.com/tarik02/webdesktop/config"
	remoteinput "github.com/tarik02/webdesktop/input"
	"github.com/tarik02/webdesktop/media"
	rtc "github.com/tarik02/webdesktop/webrtc"
	"go.uber.org/zap"
)

const (
	mediaQualityOption = "aperture"
	iceUDPPortMin      = 50000
	iceUDPPortMax      = 50010
)

type producer struct {
	cancel context.CancelFunc
	done   chan struct{}
	media  *media.Service
	webrtc *rtc.Service
	input  *remoteinput.Controller
	sender *compositorInputSender
}

type mediaSourceAdapter struct {
	source  *media.Service
	samples chan rtc.VideoSample
}

func newWebRTCProducer(values RuntimeEnvValues, controlSocket string, target string) (*producer, error) {
	if pluginPath := strings.TrimSpace(values.MediaProducerPluginPath); pluginPath != "" {
		if err := os.Setenv("GST_PLUGIN_SYSTEM_PATH_1_0", pluginPath); err != nil {
			return nil, fmt.Errorf("set GStreamer plugin path: %w", err)
		}
	}

	profileName := webdesktopconfig.VideoProfileVP8
	switch normalizeCodec(values.MediaProducerCodec) {
	case "vp8":
	case "h264-va":
		profileName = webdesktopconfig.VideoProfileH264VAAPI
	default:
		return nil, errors.New("media producer codec must be vp8 or h264-va")
	}

	profiles := webdesktopconfig.DefaultVideoProfiles()
	profile := profiles[profileName]
	mediaWidth, mediaHeight := mediaDimensions(profile, values.CompositorWidth, values.CompositorHeight, values.MediaProducerFPS)
	profile.DefaultOption = mediaQualityOption
	profile.Options = map[string]media.QualityOption{
		mediaQualityOption: {
			Label:       "Aperture",
			Width:       mediaWidth,
			Height:      mediaHeight,
			Framerate:   values.MediaProducerFPS,
			BitrateKbps: values.MediaProducerBitrateKbps,
		},
	}
	profiles = map[string]media.EncoderProfile{profileName: profile}

	logger := zap.NewNop()
	mediaService, err := media.New(media.Config{
		Profiles: profiles,
		Quality: media.Quality{
			Profile:     profileName,
			Option:      mediaQualityOption,
			Width:       mediaWidth,
			Height:      mediaHeight,
			Framerate:   values.MediaProducerFPS,
			BitrateKbps: values.MediaProducerBitrateKbps,
		},
		Tuning: media.Tuning{
			Threads:          4,
			KeyframeInterval: values.MediaProducerKeyframe,
			VP8CPUUsed:       8,
		},
	}, logger.Named("media"))
	if err != nil {
		return nil, fmt.Errorf("create webdesktop media service: %w", err)
	}

	inputController, err := remoteinput.New(remoteinput.Config{
		Enabled:   true,
		Locking:   true,
		Pointer:   true,
		Keyboard:  true,
		QueueSize: 256,
	})
	if err != nil {
		return nil, fmt.Errorf("create webdesktop input controller: %w", err)
	}
	sender := newCompositorInputSender(controlSocket, values.CompositorWidth, values.CompositorHeight)
	if err := inputController.Attach(remoteinput.Authorization{Pointer: true, Keyboard: true}, sender); err != nil {
		_ = inputController.Close()
		return nil, fmt.Errorf("attach compositor input sender: %w", err)
	}

	iceServers, iceUsername, iceCredential, err := parseICEServers(values.MediaProducerICEServers)
	if err != nil {
		_ = inputController.Close()
		return nil, err
	}
	mediaAdapter := newMediaSourceAdapter(mediaService)
	webrtcService, err := rtc.New(rtc.Config{
		ICEServers:          iceServers,
		ICEUsername:         iceUsername,
		ICECredential:       iceCredential,
		UDPPortMin:          iceUDPPortMin,
		UDPPortMax:          iceUDPPortMax,
		MaxPeers:            1,
		ReplaceExistingPeer: true,
		AllowedOrigins:      []string{"*"},
	}, mediaAdapter, nil, inputController, nil, logger.Named("webrtc"))
	if err != nil {
		_ = inputController.Close()
		return nil, fmt.Errorf("create webdesktop WebRTC service: %w", err)
	}

	source, err := media.NewPipeWireTargetSource(target)
	if err != nil {
		_ = inputController.Close()
		webrtcService.Close()
		return nil, fmt.Errorf("create PipeWire target source: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := &producer{
		cancel: cancel,
		done:   make(chan struct{}),
		media:  mediaService,
		webrtc: webrtcService,
		input:  inputController,
		sender: sender,
	}
	go result.run(ctx, source)
	return result, nil
}

func parseICEServers(raw string) ([]string, string, string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, "", "", nil
	}
	var servers []struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
	}
	if err := json.Unmarshal([]byte(raw), &servers); err != nil {
		return nil, "", "", fmt.Errorf("parse WEBRTC_MEDIA_PRODUCER_ICE_SERVERS: %w", err)
	}
	var urls []string
	var username string
	var credential string
	for _, server := range servers {
		urls = append(urls, server.URLs...)
		if server.Username == "" && server.Credential == "" {
			continue
		}
		if username != "" && (username != server.Username || credential != server.Credential) {
			return nil, "", "", errors.New("webdesktop requires shared credentials across TURN servers")
		}
		username = server.Username
		credential = server.Credential
	}
	return urls, username, credential, nil
}

func mediaDimensions(profile media.EncoderProfile, width int, height int, framerate int) (int, int) {
	scale := min(1, 7680/float64(width), 4320/float64(height))
	if profile.Limits.MaxMacroblocksPerDimension > 0 {
		maximumDimension := float64(profile.Limits.MaxMacroblocksPerDimension * 16)
		scale = min(scale, maximumDimension/float64(width), maximumDimension/float64(height))
	}
	maximumMacroblocks := profile.Limits.MaxMacroblocksPerFrame
	if profile.Limits.MaxMacroblocksPerSecond > 0 && framerate > 0 {
		maximumAtFramerate := profile.Limits.MaxMacroblocksPerSecond / framerate
		if maximumMacroblocks == 0 || maximumAtFramerate < maximumMacroblocks {
			maximumMacroblocks = maximumAtFramerate
		}
	}
	if maximumMacroblocks > 0 {
		scale = min(scale, math.Sqrt(float64(maximumMacroblocks*256)/float64(width*height)))
	}
	mediaWidth := max(320, int(float64(width)*scale)/2*2)
	mediaHeight := max(240, int(float64(height)*scale)/2*2)
	for maximumMacroblocks > 0 && ((mediaWidth+15)/16)*((mediaHeight+15)/16) > maximumMacroblocks {
		if mediaWidth*height > mediaHeight*width {
			mediaWidth -= 2
		} else {
			mediaHeight -= 2
		}
	}
	return mediaWidth, mediaHeight
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

func newMediaSourceAdapter(source *media.Service) *mediaSourceAdapter {
	adapter := &mediaSourceAdapter{source: source, samples: make(chan rtc.VideoSample)}
	go func() {
		defer close(adapter.samples)
		for sample := range source.Samples() {
			adapter.samples <- rtc.VideoSample{
				Data:       sample.Data,
				Codec:      sample.Codec,
				ProducedAt: sample.ProducedAt,
				PTS:        sample.PTS,
				PTSValid:   sample.PTSValid,
				Duration:   sample.Duration,
				KeyFrame:   sample.KeyFrame,
			}
		}
	}()
	return adapter
}

func (adapter *mediaSourceAdapter) Samples() <-chan rtc.VideoSample {
	return adapter.samples
}

func (adapter *mediaSourceAdapter) Quality() rtc.Quality {
	quality := adapter.source.Quality()
	return rtc.Quality(quality)
}

func (adapter *mediaSourceAdapter) Profile(name string) (rtc.EncoderProfile, bool) {
	profile, ok := adapter.source.Profile(name)
	if !ok {
		return rtc.EncoderProfile{}, false
	}
	options := make(map[string]rtc.QualityOption, len(profile.Options))
	for optionName, option := range profile.Options {
		options[optionName] = rtc.QualityOption(option)
	}
	feedback := make([]rtc.RTCPFeedback, len(profile.Codec.RTCPFeedback))
	for index, item := range profile.Codec.RTCPFeedback {
		feedback[index] = rtc.RTCPFeedback(item)
	}
	return rtc.EncoderProfile{
		DefaultOption:     profile.DefaultOption,
		Options:           options,
		FrontendTransform: profile.FrontendTransform,
		Codec: rtc.RTPCodec{
			ID:           profile.Codec.ID,
			MimeType:     profile.Codec.MimeType,
			ClockRate:    profile.Codec.ClockRate,
			Channels:     profile.Codec.Channels,
			PayloadType:  profile.Codec.PayloadType,
			Payloader:    profile.Codec.Payloader,
			SDPFmtpLine:  profile.Codec.SDPFmtpLine,
			RTCPFeedback: feedback,
			SDP: rtc.SDPRequirements{
				OfferFmtp:  profile.Codec.SDP.OfferFmtp,
				AnswerFmtp: profile.Codec.SDP.AnswerFmtp,
			},
		},
	}, true
}

func (adapter *mediaSourceAdapter) UpdateQuality(quality rtc.Quality) error {
	return adapter.source.UpdateQuality(media.Quality(quality))
}

func (adapter *mediaSourceAdapter) RequestKeyframe() error {
	return adapter.source.RequestKeyframe()
}

func (adapter *mediaSourceAdapter) SetActive(active bool) {
	adapter.source.SetActive(active)
}

func (p *producer) run(ctx context.Context, source media.Source) {
	defer close(p.done)
	results := make(chan error, 2)
	go func() {
		results <- p.media.Run(ctx, source)
	}()
	go func() {
		results <- p.webrtc.Run(ctx)
	}()

	first := <-results
	p.cancel()
	second := <-results
	if err := errors.Join(first, second); err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: %v\n", err)
	}
}

func (p *producer) Handler() http.Handler {
	return p.webrtc.Handler()
}

func (p *producer) setViewport(viewport compositorViewport) error {
	p.sender.SetViewport(viewport.Width, viewport.Height)
	quality := p.media.Quality()
	profile, _ := p.media.Profile(quality.Profile)
	quality.Width, quality.Height = mediaDimensions(profile, viewport.PhysicalWidth, viewport.PhysicalHeight, quality.Framerate)
	if quality == p.media.Quality() {
		return nil
	}
	return p.media.UpdateQuality(quality)
}

func (p *producer) Close() error {
	p.cancel()
	<-p.done
	return p.input.Close()
}

var _ rtc.MediaSource = (*mediaSourceAdapter)(nil)
