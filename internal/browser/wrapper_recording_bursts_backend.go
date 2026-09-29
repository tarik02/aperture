package browser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/aperture/aperture/internal/recording/timeline"
)

// screencastProcess is a capture pipeline that is watched for exiting, so that
// both its owner and whoever stops it can learn how it ended.
type screencastProcess struct {
	cmd    *exec.Cmd
	exited chan struct{}
	// err is how the process ended; it is set before exited is closed.
	err error
}

func newScreencastProcess(cmd *exec.Cmd, done <-chan error) *screencastProcess {
	process := &screencastProcess{cmd: cmd, exited: make(chan struct{})}
	go func() {
		process.err = <-done
		close(process.exited)
	}()
	return process
}

// stop asks the pipeline to finish its file (SIGINT with gst-launch's -e ends
// the stream properly), and kills it if that takes more than five seconds. The
// error is non-nil when the file cannot be trusted.
func (p *screencastProcess) stop() error {
	select {
	case <-p.exited:
	default:
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Signal(syscall.SIGINT)
		}
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-p.exited:
		case <-timer.C:
			if p.cmd.Process != nil {
				_ = p.cmd.Process.Kill()
			}
			<-p.exited
			return errors.New("recording pipeline did not stop in time")
		}
	}
	if p.err != nil {
		return fmt.Errorf("recording pipeline stopped: %w", p.err)
	}
	return nil
}

// recordingBurstBackend runs the segments of a bursts recording as capture
// pipelines of the wrapper, writing into the recording's segment directory.
type recordingBurstBackend struct {
	session   *liveSession
	recording *wrapperRecording
}

func (b *recordingBurstBackend) target(id string) (wrapperTargetSnapshot, bool) {
	r := b.session.runtime
	r.mu.Lock()
	registry := r.targets
	if id == "" {
		id = b.recording.TargetID
	}
	r.mu.Unlock()
	if registry == nil {
		return wrapperTargetSnapshot{}, false
	}
	return registry.readyTarget(id)
}

func (b *recordingBurstBackend) open(ctx context.Context, target wrapperTargetSnapshot, burst uint64) (burstSegment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r := b.session.runtime
	recording := b.recording
	// Segments are opened one at a time and only kept segments count, so the next
	// index is the number kept, which is also the timeline's index for it.
	r.mu.Lock()
	index := len(recording.segments)
	r.mu.Unlock()
	if index >= burstMaxSegments {
		return nil, fmt.Errorf("the recording has reached its limit of %d bursts", burstMaxSegments)
	}
	path := filepath.Join(recording.segmentDir, fmt.Sprintf("segment-%04d%s", index, filepath.Ext(recording.Path)))
	started := time.Now()
	cmd, done, probe, err := startWrapperScreencast(r.ctx, r.values, r.controlSocket, target.CaptureID, target.PipeWireTarget, target.Viewport, path, recording.FPS, recording.BitrateKbps, recording.Codec)
	if err != nil {
		return nil, err
	}
	segment := &recordingBurstSegment{
		backend: b,
		process: newScreencastProcess(cmd, done),
		probe:   probe,
		path:    path,
		started: started,
	}
	// The timeline samples the page from the moment its pipeline runs, so what the
	// first frames show is not missed.
	segment.index = recording.timeline.beginSegment(target, probe, started, burst)
	if segment.index != index {
		burstWarn("recording %s: burst segment %d is segment %d of its timeline", recording.ID, index, segment.index)
	}
	r.mu.Lock()
	recording.TargetID = target.TargetID
	recording.CaptureGeneration = target.Generation
	recording.viewport = target.Viewport
	r.mu.Unlock()
	return segment, nil
}

func (b *recordingBurstBackend) idleFor(ctx context.Context, targetID string) (time.Duration, error) {
	target, ready := b.target(targetID)
	if !ready {
		return 0, errors.New("the recorded page is not ready")
	}
	r := b.session.runtime
	damage, err := readCaptureDamage(ctx, r.controlSocket, target.CaptureID)
	if err != nil {
		return 0, err
	}
	return damage.Since, nil
}

func (b *recordingBurstBackend) noteAction(action timeline.ActionInput) {
	if collector := b.recording.timeline; collector != nil {
		collector.builder.AddAction(action)
	}
}

func (b *recordingBurstBackend) publish(status wrapperBurstStatus, targetID string) {
	r := b.session.runtime
	r.mu.Lock()
	defer r.mu.Unlock()
	b.recording.Burst = &status
	if targetID != "" {
		b.recording.TargetID = targetID
	}
}

func (b *recordingBurstBackend) changed() {
	b.session.broadcastRecordings()
}

func (b *recordingBurstBackend) failed(reason string, cause error) {
	go b.session.failBurstsRecording(b.recording, reason, cause)
}

// recordingBurstSegment is one burst's pipeline.
type recordingBurstSegment struct {
	backend *recordingBurstBackend
	process *screencastProcess
	probe   *screencastProbe
	path    string
	index   int
	started time.Time
}

func (s *recordingBurstSegment) FirstFrame() <-chan struct{} { return s.probe.ready }

func (s *recordingBurstSegment) Anchor() time.Time {
	if clock, ok := s.probe.clock(); ok {
		return clock.FirstFrame
	}
	return s.started
}

func (s *recordingBurstSegment) Exited() <-chan struct{} { return s.process.exited }

// Close ends the pipeline and keeps its video as the recording's next segment.
func (s *recordingBurstSegment) Close(reason string) error {
	recording := s.backend.recording
	err := s.process.stop()
	if err == nil {
		if info, statErr := os.Stat(s.path); statErr != nil {
			err = statErr
		} else if info.Size() == 0 {
			err = errors.New("the burst produced no video")
		}
	}
	if err != nil {
		return err
	}
	// The timeline learns the segment's end once its frame reports are complete.
	recording.timeline.endSegment(s.index, time.Now())
	recording.timeline.builder.SetSegmentClosedBy(s.index, reason)
	r := s.backend.session.runtime
	r.mu.Lock()
	recording.segments = append(recording.segments, s.path)
	r.mu.Unlock()
	return nil
}

func (s *recordingBurstSegment) Discard() {
	_ = s.process.stop()
	_ = os.Remove(s.path)
	s.backend.recording.timeline.discardSegment(s.index)
}
