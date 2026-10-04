package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/recording"
	"github.com/chromedp/cdproto/runtime"
)

// annotationRequest is one explicit recording tool, decoded and validated: a caption, a focus or an
// attention. Each kind reads the fields it documents; attention's point is a rect without size.
// Coordinates are surface px: CSS px of the recorded target's viewport.
type annotationRequest struct {
	kind        string
	recordingID string
	text        string
	selector    string
	rect        *recording.Rect
	zoom        float64
	radius      float64
	loops       int
	durationMS  int
}

// decodeAnnotation reads the typed arguments of a kind and checks them, so a bad request fails
// before it waits for the gate. The daemon checked them already; the wrapper is also reached by
// live-session clients.
func decodeAnnotation(kind string, body json.RawMessage) (annotationRequest, error) {
	decode := func(into interface{ Validate() error }) error {
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(into); err != nil {
			return fmt.Errorf("%w: invalid annotation request: %w", recording.ErrInvalid, err)
		}
		return into.Validate()
	}
	switch kind {
	case "caption":
		var c recording.Caption
		if err := decode(&c); err != nil {
			return annotationRequest{}, err
		}
		return annotationRequest{kind: kind, recordingID: c.RecordingID, text: c.Text, durationMS: c.DurationMS}, nil
	case "focus":
		var f recording.Focus
		if err := decode(&f); err != nil {
			return annotationRequest{}, err
		}
		return annotationRequest{kind: kind, recordingID: f.RecordingID, rect: f.Rect, selector: f.Selector, zoom: f.Zoom, durationMS: f.DurationMS}, nil
	case "attention":
		var a recording.Attention
		if err := decode(&a); err != nil {
			return annotationRequest{}, err
		}
		request := annotationRequest{kind: kind, recordingID: a.RecordingID, selector: a.Selector, radius: a.Radius, loops: a.Loops, durationMS: a.DurationMS}
		if a.Point != nil {
			request.rect = &recording.Rect{X: a.Point.X, Y: a.Point.Y}
		}
		return request, nil
	default:
		return annotationRequest{}, fmt.Errorf("%w: unknown kind %q", recording.ErrInvalid, kind)
	}
}

func (session *liveSession) handleAnnotation(w http.ResponseWriter, req *http.Request, kind string) {
	var body json.RawMessage
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid annotation request: "+err.Error())
		return
	}
	request, err := decodeAnnotation(kind, body)
	if err == nil {
		err = session.annotate(req.Context(), request)
	}
	switch {
	case errors.Is(err, recording.ErrInvalid):
		writeWrapperError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, errWrapperRecordingNotFound):
		writeWrapperError(w, http.StatusNotFound, err.Error())
	case err != nil:
		writeWrapperError(w, http.StatusConflict, err.Error())
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// annotate acts on one running recording: the one named by the request, or the only one running.
// It holds the browser-call gate while it acts, so no automation interleaves with it.
func (session *liveSession) annotate(ctx context.Context, request annotationRequest) error {
	r := session.runtime
	release, err := session.acquireRecordingGate(ctx)
	if err != nil {
		return err
	}
	defer release()
	var active *wrapperRecording
	var targetID string
	running := 0
	r.mu.Lock()
	if request.recordingID != "" && session.recordings[request.recordingID] == nil {
		r.mu.Unlock()
		return errWrapperRecordingNotFound
	}
	for _, candidate := range session.recordings {
		if candidate.Status == wrapperRecordingRunning && !candidate.stopping && (request.recordingID == "" || candidate.ID == request.recordingID) {
			active, targetID = candidate, candidate.TargetID
			running++
		}
	}
	r.mu.Unlock()
	switch running {
	case 0:
		return errors.New("no running recording")
	case 1:
	default:
		return errors.New("several recordings are running: pass recordingId")
	}
	if request.kind != "attention" && r.values.RecordingFFmpegExecutable == "" {
		return recording.ErrFFmpegRequired
	}
	var started time.Time
	var fields map[string]any
	switch request.kind {
	case "caption":
		started, fields = time.Now(), map[string]any{"text": request.text, "durationMs": request.durationMS}
	case "focus":
		started, fields, err = session.annotateFocus(ctx, targetID, request)
	default:
		started, fields, err = session.annotateAttention(ctx, targetID, request)
	}
	if err != nil {
		return err
	}
	// The recording may have stopped meanwhile (the gate does not stop an event from ending it).
	r.mu.Lock()
	member := active.Status == wrapperRecordingRunning && !active.stopping
	r.mu.Unlock()
	if !member {
		return errors.New("recording stopped")
	}
	active.journal.append(journalLine(request.kind, started, fields))
	return nil
}

// annotateFocus blocks for the duration of a zoom on a rect, so nothing else happens meanwhile.
func (session *liveSession) annotateFocus(ctx context.Context, targetID string, request annotationRequest) (time.Time, map[string]any, error) {
	rect, err := session.annotationRect(targetID, request)
	if err != nil {
		return time.Time{}, nil, err
	}
	started := time.Now()
	if err := sleepContext(ctx, time.Duration(request.durationMS)*time.Millisecond); err != nil {
		return time.Time{}, nil, err
	}
	return started, map[string]any{"targetId": targetID, "rect": rect, "zoom": request.zoom}, nil
}

// annotateAttention loops the real pointer around a point so a viewer looks there.
func (session *liveSession) annotateAttention(ctx context.Context, targetID string, request annotationRequest) (time.Time, map[string]any, error) {
	rect, err := session.annotationRect(targetID, request)
	if err != nil {
		return time.Time{}, nil, err
	}
	if session.pointer == nil {
		return time.Time{}, nil, errors.New("attention needs a compositor session")
	}
	surface, ready := session.pointer.surface(targetID)
	if !ready {
		return time.Time{}, nil, errors.New("recorded target is not ready")
	}
	automation, err := session.acquireAutomation("Recording attention")
	if err != nil {
		return time.Time{}, nil, err
	}
	defer session.releaseAutomation(automation)
	center := cdpPoint{rect.X + rect.Width/2, rect.Y + rect.Height/2}
	started := time.Now()
	if err := session.pointer.circle(ctx, surface, center, request.radius, request.loops, time.Duration(request.durationMS)*time.Millisecond, session.automationCadence().timing()); err != nil {
		return time.Time{}, nil, err
	}
	return started, map[string]any{"targetId": targetID, "x": center.x, "y": center.y, "radius": request.radius, "loops": request.loops}, nil
}

// annotationRect takes the request's rect, or resolves its selector, to a rect in surface px.
func (session *liveSession) annotationRect(targetID string, request annotationRequest) (recording.Rect, error) {
	if request.rect != nil {
		return *request.rect, nil
	}
	quoted, _ := json.Marshal(request.selector)
	expression := fmt.Sprintf(`(()=>{const e=document.querySelector(%s);if(!e)return null;const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`, quoted)
	var box []float64
	err := session.browser.withTarget(targetID, func(ctx context.Context) error {
		object, details, err := runtime.Evaluate(expression).WithReturnByValue(true).Do(ctx)
		if err != nil {
			return err
		}
		if details != nil {
			return fmt.Errorf("%w: selector is not valid", recording.ErrInvalid)
		}
		return json.Unmarshal(object.Value, &box)
	})
	if err != nil {
		return recording.Rect{}, err
	}
	if len(box) != 4 {
		return recording.Rect{}, fmt.Errorf("%w: selector matched no element", recording.ErrInvalid)
	}
	return recording.Rect{X: box[0], Y: box[1], Width: box[2], Height: box[3]}, nil
}
