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
	"github.com/tarik02/webdesktop/media"
	rtc "github.com/tarik02/webdesktop/webrtc"
	"go.uber.org/zap"
)

const (
	mediaQualityOption = "aperture"
	signalingProtocol  = "aperture-webrtc.v1"
)

type producer struct {
	cancel   context.CancelFunc
	done     chan struct{}
	media    *targetMediaSource
	profiles []mediaProfile
	webrtc   *rtc.Service
	input    *targetInputController
}

type mediaProfile struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Codec       string `json:"codec"`
	MimeType    string `json:"mimeType"`
	SDPFmtpLine string `json:"sdpFmtpLine"`
}

func newWebRTCProducer(values RuntimeEnvValues, controlSocket string) (*producer, error) {
	if values.MediaProducerUDPPortMin <= 0 || values.MediaProducerUDPPortMax < values.MediaProducerUDPPortMin || values.MediaProducerUDPPortMax > 65535 {
		return nil, errors.New("media producer ICE UDP port range is invalid")
	}
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
	case "h264-software":
		profileName = webdesktopconfig.VideoProfileH264Software
	default:
		return nil, errors.New("media producer codec must be vp8, h264-va, or h264-software")
	}

	defaultProfiles := webdesktopconfig.DefaultVideoProfiles()
	profiles := make(map[string]media.EncoderProfile, len(defaultProfiles))
	availableProfiles := make([]mediaProfile, 0, len(defaultProfiles))
	for _, candidate := range []struct {
		name  string
		codec string
	}{
		{name: webdesktopconfig.VideoProfileVP8, codec: mediaCodecVP8},
		{name: webdesktopconfig.VideoProfileH264VAAPI, codec: mediaCodecH264},
		{name: webdesktopconfig.VideoProfileH264VAAPIHigh, codec: mediaCodecH264},
		{name: webdesktopconfig.VideoProfileH264Software, codec: mediaCodecX264},
	} {
		if candidate.codec == mediaCodecH264 && values.RenderNode == "" {
			continue
		}
		if err := probeMediaCodec(values, candidate.codec); err != nil {
			continue
		}
		profile := defaultProfiles[candidate.name]
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
		profiles[candidate.name] = profile
		availableProfiles = append(availableProfiles, mediaProfile{
			ID:          candidate.name,
			Label:       profile.Label,
			Codec:       profile.Codec.ID,
			MimeType:    profile.Codec.MimeType,
			SDPFmtpLine: profile.Codec.SDPFmtpLine,
		})
	}
	profile, exists := profiles[profileName]
	if !exists {
		return nil, fmt.Errorf("selected media producer profile %q is unavailable", profileName)
	}
	mediaWidth, mediaHeight := mediaDimensions(profile, values.CompositorWidth, values.CompositorHeight, values.MediaProducerFPS)

	logger := zap.NewNop()
	mediaConfig := media.Config{
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
	}
	mediaSource := newTargetMediaSource(mediaConfig, logger.Named("media"))

	inputController := &targetInputController{
		controlSocket: controlSocket,
		targets:       mediaSource,
		inputs:        make(map[string]*targetInput),
		owners:        make(map[uint64]string),
	}

	iceServers, iceUsername, iceCredential, err := parseICEServers(values.MediaProducerICEServers)
	if err != nil {
		_ = inputController.Close()
		mediaSource.Close()
		return nil, err
	}
	var advertisedIPs []string
	if advertisedIP := strings.TrimSpace(values.MediaProducerAdvertisedIP); advertisedIP != "" {
		advertisedIPs = []string{advertisedIP}
	}
	webrtcService, err := rtc.New(rtc.Config{
		ICEServers:          iceServers,
		ICEUsername:         iceUsername,
		ICECredential:       iceCredential,
		ICEAdvertisedIPs:    advertisedIPs,
		UDPPortMin:          uint16(values.MediaProducerUDPPortMin),
		UDPPortMax:          uint16(values.MediaProducerUDPPortMax),
		Subprotocols:        []string{signalingProtocol},
		MaxPeers:            8,
		ReplaceExistingPeer: false,
		AllowedOrigins:      []string{"*"},
	}, mediaSource, nil, inputController, nil, logger.Named("webrtc"))
	if err != nil {
		_ = inputController.Close()
		mediaSource.Close()
		return nil, fmt.Errorf("create webdesktop WebRTC service: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := &producer{
		cancel:   cancel,
		done:     make(chan struct{}),
		media:    mediaSource,
		profiles: availableProfiles,
		webrtc:   webrtcService,
		input:    inputController,
	}
	go result.run(ctx)
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
	case "h264-software", "x264":
		return "h264-software"
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func (p *producer) run(ctx context.Context) {
	defer close(p.done)
	if err := p.webrtc.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper webrtc: %v\n", err)
	}
	p.media.Close()
}

func (p *producer) Handler() http.Handler {
	return p.webrtc.Handler()
}

func (p *producer) Close() error {
	p.cancel()
	<-p.done
	p.media.Close()
	return p.input.Close()
}
