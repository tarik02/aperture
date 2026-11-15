package browser

import (
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"strings"
	"time"

	"github.com/go-gst/go-gst/gst"
	gstapp "github.com/go-gst/go-gst/gst/app"
	webdesktopconfig "github.com/tarik02/webdesktop/config"
	"github.com/tarik02/webdesktop/media"
)

// RunMediaEncoderProbe runs only in the killable session-wrapper child process.
func RunMediaEncoderProbe(input io.Reader, output io.Writer) error {
	var config media.Config
	decoder := json.NewDecoder(io.LimitReader(input, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("decode encoder probe: %w", err)
	}
	if config.Quality.Width < 1 || config.Quality.Width > 7680 || config.Quality.Height < 1 || config.Quality.Height > 4320 || config.Quality.Framerate < 1 {
		return fmt.Errorf("invalid encoder probe dimensions or framerate")
	}
	profile, ok := config.Profiles[config.Quality.Profile]
	if !ok {
		return fmt.Errorf("encoder probe profile %q is missing", config.Quality.Profile)
	}
	gst.Init(nil)
	if err := requireCaptureElements(); err != nil {
		return err
	}
	profile, err := omitUnsupportedEncoderHints(config.Quality.Profile, profile)
	if err != nil {
		return err
	}
	if err := profile.Validate(config.Quality.Profile, config.Tuning); err != nil {
		return err
	}
	if err := probeEncodedKeyframe(config, profile); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(profile)
}

func requireCaptureElements() error {
	// PipeWire is not live yet; missing capture dependencies must still reject it.
	for _, name := range []string{"pipewiresrc", "queue", "videorate", "appsrc", "appsink"} {
		element, err := gst.NewElement(name)
		if err != nil {
			return fmt.Errorf("capture dependency %s: %w", name, err)
		}
		runtime.SetFinalizer(element.GObject(), nil)
		element.Unref()
	}
	return nil
}

func omitUnsupportedEncoderHints(name string, profile media.EncoderProfile) (media.EncoderProfile, error) {
	var factory string
	var hints []string
	switch name {
	case webdesktopconfig.VideoProfileH264VAAPI, webdesktopconfig.VideoProfileH264VAAPIHigh:
		factory = "vah264enc"
		hints = []string{"b-frames=0", "cabac=false", "cabac=true", "dct8x8=false", "dct8x8=true", "rate-control=cbr"}
	case mediaProfileNVENC:
		factory = "nvh264enc"
		hints = []string{"bframes=0", "zerolatency=true", "rc-mode=cbr"}
	default:
		return profile, nil
	}
	element, err := gst.NewElement(factory)
	if err != nil {
		return media.EncoderProfile{}, err
	}
	runtime.SetFinalizer(element.GObject(), nil)
	defer element.Unref()
	for _, hint := range hints {
		property, _, _ := strings.Cut(hint, "=")
		if _, err := element.GetProperty(property); err != nil {
			profile.Pipeline = strings.ReplaceAll(profile.Pipeline, hint, "")
		}
	}
	return profile, nil
}

func probeEncodedKeyframe(config media.Config, profile media.EncoderProfile) error {
	path, err := profile.RenderPipeline(config.Quality.Profile, "probe", config.Quality, config.Tuning)
	if err != nil {
		return err
	}
	description := fmt.Sprintf(`appsrc name=probe-source is-live=true format=time block=false !
videorate drop-only=true max-rate=%d skip-to-first=true !
%s ! appsink name=probe-sink sync=false async=false wait-on-eos=false enable-last-sample=false max-buffers=1`, config.Quality.Framerate, path)
	pipeline, err := gst.NewPipelineFromString(description)
	if err != nil {
		return fmt.Errorf("create encoder pipeline: %w", err)
	}
	defer func() { _ = pipeline.SetState(gst.StateNull) }()
	if err := pushProbeFrame(pipeline, config.Quality); err != nil {
		return err
	}
	return pullProbeKeyframe(pipeline)
}

func pushProbeFrame(pipeline *gst.Pipeline, quality media.Quality) error {
	element, err := pipeline.GetElementByName("probe-source")
	if err != nil {
		return err
	}
	source := gstapp.SrcFromElement(element)
	// Exercise conversion and resizing from Weston's ordinary raw buffers.
	width, height := quality.Width+2, quality.Height+2
	source.SetCaps(gst.NewCapsFromString(fmt.Sprintf("video/x-raw,format=BGRx,width=%d,height=%d,framerate=%d/1", width, height, quality.Framerate)))
	if err := pipeline.SetState(gst.StatePlaying); err != nil {
		return err
	}
	buffer := gst.NewBufferFromBytes(make([]byte, width*height*4))
	buffer.SetPresentationTimestamp(0)
	buffer.SetDuration(gst.ClockTime(time.Second / time.Duration(quality.Framerate)))
	flow := source.PushBuffer(buffer)
	runtime.SetFinalizer(buffer, nil)
	buffer.Unref()
	if flow != gst.FlowOK {
		return fmt.Errorf("push probe frame: %s", flow)
	}
	if flow := source.EndStream(); flow != gst.FlowOK {
		return fmt.Errorf("finish probe frame: %s", flow)
	}
	return nil
}

func pullProbeKeyframe(pipeline *gst.Pipeline) error {
	element, err := pipeline.GetElementByName("probe-sink")
	if err != nil {
		return err
	}
	sink := gstapp.SinkFromElement(element)
	sample := sink.TryPullSample(gst.ClockTime(4 * time.Second))
	if sample == nil {
		if message := pipeline.GetBus().TimedPopFiltered(0, gst.MessageError); message != nil {
			return fmt.Errorf("encoder pipeline: %v", message.ParseError())
		}
		return fmt.Errorf("encoder emitted no keyframe within 4s")
	}
	runtime.SetFinalizer(sample, nil)
	defer sample.Unref()
	encoded := sample.GetBuffer()
	if encoded == nil || encoded.GetSize() == 0 || encoded.HasFlags(gst.BufferFlagDeltaUnit) {
		return fmt.Errorf("encoder emitted no non-empty keyframe")
	}
	return nil
}
