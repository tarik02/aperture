package browser

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/tarik02/webdesktop/media"
	rtc "github.com/tarik02/webdesktop/webrtc"
	"go.uber.org/zap"
)

type targetEncoder struct {
	target        wrapperTargetSnapshot
	service       *media.Service
	cancel        context.CancelFunc
	firstKeyframe chan rtc.VideoSample
}

type peerTargetSelection struct {
	targetID   string
	generation uint64
}

type peerTargetWaiter struct {
	targetID   string
	generation uint64
	ready      chan struct{}
}

type targetMediaSource struct {
	ctx           context.Context
	cancel        context.CancelFunc
	config        media.Config
	logger        *zap.Logger
	samples       chan rtc.VideoSample
	events        chan rtc.TargetEvent
	close         sync.Once
	wait          sync.WaitGroup
	mu            sync.Mutex
	active        bool
	closed        bool
	quality       media.Quality
	targets       map[string]*targetEncoder
	selected      map[uint64]peerTargetSelection
	confirmed     map[uint64]peerTargetSelection
	transitioning map[string]struct{}
	generations   map[uint64]uint64
	waiters       map[uint64]peerTargetWaiter
}

func newTargetMediaSource(config media.Config, logger *zap.Logger) *targetMediaSource {
	ctx, cancel := context.WithCancel(context.Background())
	return &targetMediaSource{
		ctx:           ctx,
		cancel:        cancel,
		config:        config,
		logger:        logger,
		samples:       make(chan rtc.VideoSample),
		events:        make(chan rtc.TargetEvent, 64),
		quality:       config.Quality,
		targets:       make(map[string]*targetEncoder),
		selected:      make(map[uint64]peerTargetSelection),
		confirmed:     make(map[uint64]peerTargetSelection),
		transitioning: make(map[string]struct{}),
		generations:   make(map[uint64]uint64),
		waiters:       make(map[uint64]peerTargetWaiter),
	}
}

func (source *targetMediaSource) SetTarget(ctx context.Context, target wrapperTargetSnapshot) error {
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return errors.New("target media source is closed")
	}
	quality := source.quality
	active := source.active
	previous := source.targets[target.TargetID]
	selected := false
	for _, selection := range source.selected {
		if selection.targetID == target.TargetID {
			selected = true
			break
		}
	}
	source.mu.Unlock()

	profile := source.config.Profiles[quality.Profile]
	quality.Width, quality.Height = mediaDimensions(profile, target.Viewport.PhysicalWidth, target.Viewport.PhysicalHeight, quality.Framerate)
	config := source.config
	config.Quality = quality
	service, err := media.New(config, source.logger.Named(target.TargetID))
	if err != nil {
		return fmt.Errorf("create target encoder for %s: %w", target.TargetID, err)
	}
	pipeWireSource, err := media.NewPipeWireTargetSource(target.PipeWireTarget)
	if err != nil {
		return fmt.Errorf("create target PipeWire source for %s: %w", target.TargetID, err)
	}
	encoderCtx, cancel := context.WithCancel(source.ctx)
	encoder := &targetEncoder{
		target:        target,
		service:       service,
		cancel:        cancel,
		firstKeyframe: make(chan rtc.VideoSample, 1),
	}
	service.SetActive(active)
	source.wait.Add(2)
	go func() {
		defer source.wait.Done()
		if err := service.Run(encoderCtx, pipeWireSource); err != nil && encoderCtx.Err() == nil {
			source.logger.Error("target encoder stopped", zap.String("target_id", target.TargetID), zap.Error(err))
		}
	}()
	go source.forwardEncoder(encoderCtx, encoder)

	var firstKeyframe rtc.VideoSample
	if previous != nil && active && selected {
		select {
		case <-ctx.Done():
			cancel()
			return fmt.Errorf("wait for replacement keyframe for %s: %w", target.TargetID, ctx.Err())
		case firstKeyframe = <-encoder.firstKeyframe:
		}
	}

	source.mu.Lock()
	if source.closed || source.targets[target.TargetID] != previous {
		source.mu.Unlock()
		cancel()
		return errors.New("target media generation was superseded")
	}
	source.targets[target.TargetID] = encoder
	delete(source.transitioning, target.TargetID)
	updates := make([]rtc.TargetEvent, 0)
	if previous != nil {
		for peerID, selection := range source.selected {
			if selection.targetID == target.TargetID {
				updates = append(updates, rtc.TargetEvent{
					Kind:   rtc.TargetEventUpdated,
					PeerID: peerID,
					Target: rtc.TargetSelection{
						TargetID:          target.TargetID,
						Generation:        selection.generation,
						Width:             target.Viewport.Width,
						Height:            target.Viewport.Height,
						PhysicalWidth:     target.Viewport.PhysicalWidth,
						PhysicalHeight:    target.Viewport.PhysicalHeight,
						DeviceScaleFactor: target.Viewport.DeviceScaleFactor,
					},
				})
			}
		}
	}
	source.mu.Unlock()
	if firstKeyframe.Data != nil {
		if !source.publish(encoder, firstKeyframe) {
			cancel()
			return errors.New("target media source closed during replacement")
		}
	}
	if previous != nil {
		previous.cancel()
	}
	for _, update := range updates {
		select {
		case <-source.ctx.Done():
			return errors.New("target media source closed during replacement")
		case source.events <- update:
		}
	}
	return nil
}

func (source *targetMediaSource) forwardEncoder(ctx context.Context, encoder *targetEncoder) {
	defer source.wait.Done()
	firstKeyframeSent := false
	for {
		select {
		case <-ctx.Done():
			return
		case sample, ok := <-encoder.service.Samples():
			if !ok {
				return
			}
			converted := rtc.VideoSample{
				Data:       sample.Data,
				Codec:      sample.Codec,
				TargetID:   encoder.target.TargetID,
				ProducedAt: sample.ProducedAt,
				PTS:        sample.PTS,
				PTSValid:   sample.PTSValid,
				Duration:   sample.Duration,
				KeyFrame:   sample.KeyFrame,
			}
			if sample.KeyFrame && !firstKeyframeSent {
				firstKeyframeSent = true
				encoder.firstKeyframe <- converted
			}
			source.mu.Lock()
			current := source.targets[encoder.target.TargetID] == encoder
			source.mu.Unlock()
			if current && !source.publish(encoder, converted) {
				return
			}
		}
	}
}

func (source *targetMediaSource) publish(encoder *targetEncoder, sample rtc.VideoSample) bool {
	select {
	case <-source.ctx.Done():
		return false
	case source.samples <- sample:
	}
	return true
}

func (source *targetMediaSource) RemoveTarget(targetID string) {
	source.mu.Lock()
	encoder := source.targets[targetID]
	delete(source.targets, targetID)
	delete(source.transitioning, targetID)
	events := make([]rtc.TargetEvent, 0)
	for peerID, selection := range source.selected {
		if selection.targetID == targetID {
			events = append(events, rtc.TargetEvent{
				Kind:     rtc.TargetEventUnavailable,
				PeerID:   peerID,
				TargetID: targetID,
				Reason:   "selected target is unavailable",
			})
			delete(source.selected, peerID)
			if waiter, exists := source.waiters[peerID]; exists {
				close(waiter.ready)
			}
			delete(source.waiters, peerID)
		}
	}
	for peerID, selection := range source.confirmed {
		if selection.targetID == targetID {
			delete(source.confirmed, peerID)
		}
	}
	source.mu.Unlock()
	if encoder != nil {
		encoder.cancel()
	}
	for _, event := range events {
		select {
		case <-source.ctx.Done():
			return
		case source.events <- event:
		}
	}
}

func (source *targetMediaSource) SelectedTarget(peerID uint64) (wrapperTargetSnapshot, bool) {
	source.mu.Lock()
	defer source.mu.Unlock()
	selection, exists := source.confirmed[peerID]
	if !exists {
		return wrapperTargetSnapshot{}, false
	}
	if _, transitioning := source.transitioning[selection.targetID]; transitioning {
		return wrapperTargetSnapshot{}, false
	}
	encoder := source.targets[selection.targetID]
	if encoder == nil {
		return wrapperTargetSnapshot{}, false
	}
	return encoder.target, true
}

func (source *targetMediaSource) SelectTarget(ctx context.Context, peerID uint64, generation uint64, targetID string) (rtc.TargetSelection, error) {
	if err := ctx.Err(); err != nil {
		return rtc.TargetSelection{}, err
	}
	source.mu.Lock()
	if generation <= source.generations[peerID] {
		source.mu.Unlock()
		return rtc.TargetSelection{}, errors.New("target selection was superseded")
	}
	source.generations[peerID] = generation
	encoder := source.targets[targetID]
	if encoder == nil {
		source.mu.Unlock()
		return rtc.TargetSelection{}, errors.New("target is unavailable")
	}
	source.selected[peerID] = peerTargetSelection{targetID: targetID, generation: generation}
	waiter := peerTargetWaiter{targetID: targetID, generation: generation, ready: make(chan struct{})}
	if previous, exists := source.waiters[peerID]; exists {
		close(previous.ready)
	}
	source.waiters[peerID] = waiter
	source.mu.Unlock()
	for {
		if err := encoder.service.RequestKeyframe(); err == nil {
			break
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			source.rollbackSelection(peerID, generation)
			return rtc.TargetSelection{}, ctx.Err()
		case <-timer.C:
		}
	}
	select {
	case <-ctx.Done():
		source.rollbackSelection(peerID, generation)
		return rtc.TargetSelection{}, ctx.Err()
	case <-waiter.ready:
	}
	source.mu.Lock()
	selection := source.selected[peerID]
	current := source.targets[targetID]
	if selection.targetID != targetID || selection.generation != generation || current == nil {
		source.mu.Unlock()
		return rtc.TargetSelection{}, errors.New("target selection was superseded")
	}
	source.confirmed[peerID] = selection
	source.mu.Unlock()
	return rtc.TargetSelection{
		TargetID:          targetID,
		Generation:        generation,
		Width:             current.target.Viewport.Width,
		Height:            current.target.Viewport.Height,
		PhysicalWidth:     current.target.Viewport.PhysicalWidth,
		PhysicalHeight:    current.target.Viewport.PhysicalHeight,
		DeviceScaleFactor: current.target.Viewport.DeviceScaleFactor,
	}, nil
}

func (source *targetMediaSource) rollbackSelection(peerID uint64, generation uint64) {
	source.mu.Lock()
	selection := source.selected[peerID]
	if selection.generation == generation {
		if confirmed, exists := source.confirmed[peerID]; exists {
			source.selected[peerID] = confirmed
		} else {
			delete(source.selected, peerID)
		}
	}
	if waiter, exists := source.waiters[peerID]; exists && waiter.generation == generation {
		delete(source.waiters, peerID)
	}
	source.mu.Unlock()
}

func (source *targetMediaSource) ReleaseTarget(peerID uint64) {
	source.mu.Lock()
	delete(source.selected, peerID)
	delete(source.confirmed, peerID)
	delete(source.generations, peerID)
	if waiter, exists := source.waiters[peerID]; exists {
		close(waiter.ready)
	}
	delete(source.waiters, peerID)
	source.mu.Unlock()
}

func (source *targetMediaSource) AcceptsTarget(peerID uint64, targetID string) bool {
	source.mu.Lock()
	defer source.mu.Unlock()
	if _, transitioning := source.transitioning[targetID]; transitioning {
		return false
	}
	return source.selected[peerID].targetID == targetID
}

func (source *targetMediaSource) SuspendTarget(targetID string) {
	source.mu.Lock()
	source.transitioning[targetID] = struct{}{}
	source.mu.Unlock()
}

func (source *targetMediaSource) RestoreTarget(targetID string) {
	source.mu.Lock()
	delete(source.transitioning, targetID)
	source.mu.Unlock()
}

func (source *targetMediaSource) ConfirmTargetFrame(peerID uint64, targetID string) {
	source.mu.Lock()
	waiter, exists := source.waiters[peerID]
	selection := source.selected[peerID]
	if exists && waiter.targetID == targetID && selection.targetID == targetID && selection.generation == waiter.generation {
		close(waiter.ready)
		delete(source.waiters, peerID)
	}
	source.mu.Unlock()
}

func (source *targetMediaSource) RequestTargetKeyframe(peerID uint64) error {
	source.mu.Lock()
	selection := source.selected[peerID]
	encoder := source.targets[selection.targetID]
	source.mu.Unlock()
	if encoder == nil {
		return errors.New("selected target is unavailable")
	}
	return encoder.service.RequestKeyframe()
}

func (source *targetMediaSource) Samples() <-chan rtc.VideoSample {
	return source.samples
}

func (source *targetMediaSource) TargetEvents() <-chan rtc.TargetEvent {
	return source.events
}

func (source *targetMediaSource) Quality() rtc.Quality {
	source.mu.Lock()
	defer source.mu.Unlock()
	return rtc.Quality(source.quality)
}

func (source *targetMediaSource) Profile(name string) (rtc.EncoderProfile, bool) {
	profile, ok := source.config.Profiles[name]
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

func (source *targetMediaSource) UpdateQuality(quality rtc.Quality) error {
	source.mu.Lock()
	encoders := make([]*targetEncoder, 0, len(source.targets))
	for _, encoder := range source.targets {
		encoders = append(encoders, encoder)
	}
	source.mu.Unlock()
	for _, encoder := range encoders {
		targetQuality := media.Quality(quality)
		profile := source.config.Profiles[targetQuality.Profile]
		targetQuality.Width, targetQuality.Height = mediaDimensions(profile, encoder.target.Viewport.PhysicalWidth, encoder.target.Viewport.PhysicalHeight, targetQuality.Framerate)
		if err := encoder.service.UpdateQuality(targetQuality); err != nil {
			return err
		}
	}
	source.mu.Lock()
	source.quality = media.Quality(quality)
	source.mu.Unlock()
	return nil
}

func (source *targetMediaSource) SetBitrate(bitrateKbps int) error {
	source.mu.Lock()
	encoders := make([]*targetEncoder, 0, len(source.targets))
	for _, encoder := range source.targets {
		encoders = append(encoders, encoder)
	}
	source.mu.Unlock()
	for _, encoder := range encoders {
		if err := encoder.service.SetBitrate(bitrateKbps); err != nil {
			return err
		}
	}
	source.mu.Lock()
	source.quality.BitrateKbps = bitrateKbps
	source.mu.Unlock()
	return nil
}

func (source *targetMediaSource) RequestKeyframe() error {
	source.mu.Lock()
	encoders := make([]*targetEncoder, 0, len(source.targets))
	for _, encoder := range source.targets {
		encoders = append(encoders, encoder)
	}
	source.mu.Unlock()
	var requestErr error
	for _, encoder := range encoders {
		requestErr = errors.Join(requestErr, encoder.service.RequestKeyframe())
	}
	return requestErr
}

func (source *targetMediaSource) SetActive(active bool) {
	source.mu.Lock()
	source.active = active
	encoders := make([]*targetEncoder, 0, len(source.targets))
	for _, encoder := range source.targets {
		encoders = append(encoders, encoder)
	}
	source.mu.Unlock()
	for _, encoder := range encoders {
		encoder.service.SetActive(active)
	}
}

func (source *targetMediaSource) Close() {
	source.close.Do(func() {
		source.mu.Lock()
		source.closed = true
		for _, waiter := range source.waiters {
			close(waiter.ready)
		}
		source.waiters = make(map[uint64]peerTargetWaiter)
		source.mu.Unlock()
		source.cancel()
		source.wait.Wait()
		close(source.samples)
	})
}

var _ rtc.MediaSource = (*targetMediaSource)(nil)
var _ rtc.TargetMediaSource = (*targetMediaSource)(nil)
var _ rtc.TargetEventSource = (*targetMediaSource)(nil)
