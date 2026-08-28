package browser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-gst/go-gst/gst"
	"github.com/go-gst/go-gst/gst/app"
)

const cdpRecordingFrameQueueCapacity = 3

type wrapperCDPRecordingOptions struct {
	Format  string `json:"format"`
	Quality int    `json:"quality,omitempty"`
}

type cdpRecordingFrame struct {
	body       []byte
	capturedAt time.Time
}

type decodedCDPRecordingFrame struct {
	pixels     []byte
	width      int
	height     int
	capturedAt time.Time
}

type cdpRecordingSegment struct {
	values      RuntimeEnvValues
	targetID    string
	path        string
	codec       string
	fps         int
	bitrateKbps int
	options     wrapperCDPRecordingOptions
	counter     func(accepted uint64, dropped uint64)

	stopOnce  sync.Once
	abortOnce sync.Once
	stop      chan struct{}
	abort     chan struct{}
	cancel    context.CancelFunc
	readyOnce sync.Once
	ready     chan struct{}
	done      chan struct{}
	mu        sync.Mutex
	err       error
}

type cdpRecordingPipeline struct {
	pipeline *gst.Pipeline
	source   *app.Source
}

var cdpGStreamerInit struct {
	sync.Once
	err error
}

func normalizeCDPRecordingOptions(options *wrapperCDPRecordingOptions) (wrapperCDPRecordingOptions, error) {
	normalized := wrapperCDPRecordingOptions{Format: "jpeg", Quality: 80}
	if options != nil {
		if strings.TrimSpace(options.Format) != "" {
			normalized.Format = strings.ToLower(strings.TrimSpace(options.Format))
		}
		if options.Quality != 0 {
			normalized.Quality = options.Quality
		}
	}
	switch normalized.Format {
	case "jpeg":
		if normalized.Quality < 1 || normalized.Quality > 100 {
			return wrapperCDPRecordingOptions{}, errors.New("cdp.quality must be between 1 and 100 for JPEG")
		}
	case "png":
		if options != nil && options.Quality != 0 {
			return wrapperCDPRecordingOptions{}, errors.New("cdp.quality is only valid for JPEG")
		}
		normalized.Quality = 0
	default:
		return wrapperCDPRecordingOptions{}, errors.New("cdp.format must be jpeg or png")
	}
	return normalized, nil
}

func startCDPRecordingSegment(
	ctx context.Context,
	values RuntimeEnvValues,
	targetID string,
	path string,
	fps int,
	bitrateKbps int,
	codec string,
	options wrapperCDPRecordingOptions,
	counter func(accepted uint64, dropped uint64),
) (*cdpRecordingSegment, error) {
	segmentCtx, cancel := context.WithCancel(ctx)
	segment := &cdpRecordingSegment{
		values:      values,
		targetID:    targetID,
		path:        path,
		codec:       codec,
		fps:         fps,
		bitrateKbps: bitrateKbps,
		options:     options,
		counter:     counter,
		stop:        make(chan struct{}),
		abort:       make(chan struct{}),
		cancel:      cancel,
		ready:       make(chan struct{}),
		done:        make(chan struct{}),
	}
	started := make(chan error, 1)
	go segment.run(segmentCtx, started)
	select {
	case <-ctx.Done():
		segment.Abort()
		return nil, ctx.Err()
	case err := <-started:
		if err != nil {
			return nil, err
		}
		return segment, nil
	}
}

func (segment *cdpRecordingSegment) run(ctx context.Context, started chan<- error) {
	var runErr error
	defer func() {
		segment.cancel()
		if runErr != nil {
			_ = os.Remove(segment.path)
			for _, path := range cdpRecordingPartPaths(segment.path) {
				_ = os.Remove(path)
			}
		}
		segment.mu.Lock()
		segment.err = runErr
		segment.mu.Unlock()
		close(segment.done)
	}()

	client, err := newBrowserCDPEventClient(ctx, segment.values.CDPPort)
	if err != nil {
		runErr = err
		started <- err
		return
	}
	defer client.Close()
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := client.Call(ctx, "", "Target.attachToTarget", map[string]any{
		"targetId": segment.targetID,
		"flatten":  true,
	}, &attached); err != nil {
		runErr = err
		started <- err
		return
	}
	startParams := map[string]any{"format": segment.options.Format}
	if segment.options.Format == "jpeg" {
		startParams["quality"] = segment.options.Quality
	}
	if err := client.Call(ctx, attached.SessionID, "Page.startScreencast", startParams, nil); err != nil {
		runErr = err
		started <- err
		return
	}
	started <- nil

	frames := make(chan cdpRecordingFrame, cdpRecordingFrameQueueCapacity)
	encoderDone := make(chan error, 1)
	go func() {
		encoderDone <- segment.encode(ctx, frames)
	}()

	var captureErr error
	var encoderErr error
	encoderFinished := false
	lastAcceptedAt := time.Time{}
	capturing := true
	for capturing {
		select {
		case <-segment.abort:
			captureErr = errors.New("CDP recording aborted")
			capturing = false
		case <-segment.stop:
			stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = client.Call(stopCtx, attached.SessionID, "Page.stopScreencast", map[string]any{}, nil)
			cancel()
			capturing = false
		case encoderErr = <-encoderDone:
			encoderFinished = true
			if encoderErr == nil {
				encoderErr = errors.New("CDP encoder exited before capture stopped")
			}
			capturing = false
		case event, ok := <-client.events:
			if !ok {
				select {
				case clientErr := <-client.done:
					captureErr = clientErr
				default:
				}
				if captureErr == nil {
					captureErr = errors.New("browser CDP connection closed")
				}
				capturing = false
				continue
			}
			if event.SessionID != attached.SessionID || event.Method != "Page.screencastFrame" {
				continue
			}
			var params struct {
				Data      string `json:"data"`
				SessionID int    `json:"sessionId"`
			}
			if err := json.Unmarshal(event.Params, &params); err != nil {
				segment.counter(0, 1)
				continue
			}
			if err := client.SendBestEffort(ctx, attached.SessionID, "Page.screencastFrameAck", map[string]any{"sessionId": params.SessionID}); err != nil {
				captureErr = err
				capturing = false
				continue
			}
			body, err := base64.StdEncoding.DecodeString(params.Data)
			if err != nil {
				segment.counter(0, 1)
				continue
			}
			now := time.Now()
			if segment.fps > 0 && !lastAcceptedAt.IsZero() && now.Sub(lastAcceptedAt) < time.Second/time.Duration(segment.fps) {
				segment.counter(0, 1)
				continue
			}
			frame := cdpRecordingFrame{body: body, capturedAt: now}
			select {
			case frames <- frame:
				lastAcceptedAt = now
				segment.counter(1, 0)
			default:
				select {
				case <-frames:
					segment.counter(0, 1)
				default:
				}
				frames <- frame
				lastAcceptedAt = now
				segment.counter(1, 0)
			}
		}
	}
	client.Close()
	close(frames)
	if !encoderFinished {
		encoderErr = <-encoderDone
	}
	if captureErr != nil {
		runErr = captureErr
		return
	}
	if encoderErr != nil {
		runErr = encoderErr
		return
	}
}

func (segment *cdpRecordingSegment) encode(ctx context.Context, frames <-chan cdpRecordingFrame) error {
	if err := initCDPGStreamer(segment.values); err != nil {
		return err
	}
	partPaths := make([]string, 0, 1)
	var pipeline *cdpRecordingPipeline
	var pending decodedCDPRecordingFrame
	havePending := false
	partStartedAt := time.Time{}
	finishPipeline := func(endAt time.Time) error {
		if pipeline == nil {
			return nil
		}
		if havePending {
			duration := endAt.Sub(pending.capturedAt)
			if duration <= 0 {
				duration = time.Nanosecond
			}
			if err := pipeline.Push(pending, pending.capturedAt.Sub(partStartedAt), duration); err != nil {
				return err
			}
			segment.readyOnce.Do(func() { close(segment.ready) })
			havePending = false
		}
		if err := pipeline.Finish(); err != nil {
			return err
		}
		pipeline = nil
		return nil
	}

	for frame := range frames {
		decoded, err := decodeCDPRecordingFrame(frame)
		if err != nil {
			segment.counter(0, 1)
			continue
		}
		if pipeline == nil || decoded.width != pending.width || decoded.height != pending.height {
			if pipeline != nil {
				if err := finishPipeline(decoded.capturedAt); err != nil {
					return err
				}
			}
			partPath := cdpRecordingPartPath(segment.path, len(partPaths))
			pipeline, err = newCDPRecordingPipeline(segment.values, partPath, decoded.width, decoded.height, segment.bitrateKbps, segment.codec)
			if err != nil {
				return err
			}
			partPaths = append(partPaths, partPath)
			partStartedAt = decoded.capturedAt
			pending = decoded
			havePending = true
			continue
		}
		if havePending {
			duration := decoded.capturedAt.Sub(pending.capturedAt)
			if duration <= 0 {
				duration = time.Nanosecond
			}
			if err := pipeline.Push(pending, pending.capturedAt.Sub(partStartedAt), duration); err != nil {
				return err
			}
			segment.readyOnce.Do(func() { close(segment.ready) })
		}
		pending = decoded
		havePending = true
	}
	if pipeline == nil {
		return errors.New("CDP recording received no decodable frames")
	}
	if err := finishPipeline(time.Now()); err != nil {
		return err
	}
	return joinRecordingFiles(ctx, segment.values, segment.codec, partPaths, segment.path)
}

func decodeCDPRecordingFrame(frame cdpRecordingFrame) (decodedCDPRecordingFrame, error) {
	decoded, _, err := image.Decode(bytes.NewReader(frame.body))
	if err != nil {
		return decodedCDPRecordingFrame{}, fmt.Errorf("decode CDP screencast frame: %w", err)
	}
	bounds := decoded.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width <= 0 || height <= 0 {
		return decodedCDPRecordingFrame{}, errors.New("CDP screencast frame has invalid dimensions")
	}
	rgba := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(rgba, rgba.Bounds(), decoded, bounds.Min, draw.Src)
	return decodedCDPRecordingFrame{
		pixels:     rgba.Pix,
		width:      width,
		height:     height,
		capturedAt: frame.capturedAt,
	}, nil
}

func initCDPGStreamer(values RuntimeEnvValues) error {
	cdpGStreamerInit.Do(func() {
		if pluginPath := strings.TrimSpace(values.MediaProducerPluginPath); pluginPath != "" {
			if err := os.Setenv("GST_PLUGIN_SYSTEM_PATH_1_0", pluginPath); err != nil {
				cdpGStreamerInit.err = err
				return
			}
		}
		if err := os.Setenv("GST_REGISTRY_1_0", filepath.Join(values.CacheDir, "gstreamer-registry.bin")); err != nil {
			cdpGStreamerInit.err = err
			return
		}
		gst.Init(nil)
	})
	return cdpGStreamerInit.err
}

func newCDPRecordingPipeline(values RuntimeEnvValues, path string, width int, height int, bitrateKbps int, codec string) (*cdpRecordingPipeline, error) {
	pipelineParts := []string{
		"appsrc", "name=frames", "is-live=true", "block=true", "max-buffers=1",
		"!", "videocrop", fmt.Sprintf("right=%d", width%2), fmt.Sprintf("bottom=%d", height%2),
		"!",
	}
	pipelineParts = append(pipelineParts, wrapperRecordingPipeline(codec, bitrateKbps, values.MediaProducerKeyframe)...)
	pipelineParts = append(pipelineParts, "!", "filesink", "name=output", "sync=false")
	pipeline, err := gst.NewPipelineFromString(strings.Join(pipelineParts, " "))
	if err != nil {
		return nil, fmt.Errorf("create CDP recording pipeline: %w", err)
	}
	sourceElement, err := pipeline.GetElementByName("frames")
	if err != nil {
		_ = pipeline.SetState(gst.StateNull)
		return nil, err
	}
	source := app.SrcFromElement(sourceElement)
	source.SetCaps(gst.NewCapsFromString(fmt.Sprintf("video/x-raw,format=RGBA,width=%d,height=%d,framerate=0/1", width, height)))
	if err := source.SetProperty("format", gst.FormatTime); err != nil {
		_ = pipeline.SetState(gst.StateNull)
		return nil, err
	}
	output, err := pipeline.GetElementByName("output")
	if err != nil {
		_ = pipeline.SetState(gst.StateNull)
		return nil, err
	}
	if err := output.SetProperty("location", path); err != nil {
		_ = pipeline.SetState(gst.StateNull)
		return nil, err
	}
	if err := pipeline.SetState(gst.StatePlaying); err != nil {
		_ = pipeline.SetState(gst.StateNull)
		return nil, err
	}
	return &cdpRecordingPipeline{pipeline: pipeline, source: source}, nil
}

func (pipeline *cdpRecordingPipeline) Push(frame decodedCDPRecordingFrame, pts time.Duration, duration time.Duration) error {
	buffer := gst.NewBufferFromBytes(frame.pixels)
	buffer.SetPresentationTimestamp(gst.ClockTime(pts))
	buffer.SetDuration(gst.ClockTime(duration))
	if flow := pipeline.source.PushBuffer(buffer); flow != gst.FlowOK {
		return fmt.Errorf("push CDP recording frame: %s", flow.String())
	}
	return nil
}

func (pipeline *cdpRecordingPipeline) Finish() error {
	defer func() { _ = pipeline.pipeline.SetState(gst.StateNull) }()
	if flow := pipeline.source.EndStream(); flow != gst.FlowOK {
		return fmt.Errorf("finish CDP recording stream: %s", flow.String())
	}
	message := pipeline.pipeline.GetPipelineBus().TimedPopFiltered(
		gst.ClockTime(5*time.Second),
		gst.MessageEOS|gst.MessageError,
	)
	if message == nil {
		return errors.New("timed out finalizing CDP recording pipeline")
	}
	if message.Type() == gst.MessageError {
		return message.ParseError()
	}
	return nil
}

func (segment *cdpRecordingSegment) Ready() <-chan struct{} {
	return segment.ready
}

func (segment *cdpRecordingSegment) Done() <-chan struct{} {
	return segment.done
}

func (segment *cdpRecordingSegment) Err() error {
	segment.mu.Lock()
	defer segment.mu.Unlock()
	return segment.err
}

func (segment *cdpRecordingSegment) Stop(ctx context.Context) error {
	segment.stopOnce.Do(func() { close(segment.stop) })
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-segment.done:
		return segment.Err()
	}
}

func (segment *cdpRecordingSegment) Abort() {
	segment.abortOnce.Do(func() { close(segment.abort) })
	segment.cancel()
	<-segment.done
}

func cdpRecordingPartPath(path string, index int) string {
	extension := filepath.Ext(path)
	return strings.TrimSuffix(path, extension) + fmt.Sprintf(".cdp-%04d", index) + extension
}

func cdpRecordingPartPaths(path string) []string {
	extension := filepath.Ext(path)
	matches, _ := filepath.Glob(strings.TrimSuffix(path, extension) + ".cdp-*" + extension)
	return matches
}
