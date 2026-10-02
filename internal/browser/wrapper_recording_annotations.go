package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/chromedp/cdproto/runtime"
)

// The explicit recording tools. Each one acts on one running recording: the one named by
// recordingId, or the only one running. They hold the browser-call gate while they act, so no
// automation interleaves with them.
const (
	captionMaxRunes = 200
	focusMaxZoom    = 4.0
)

var errAnnotationInvalid = errors.New("invalid annotation")

type annotationRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type annotationPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// annotationRequest is the body of every kind; each reads the fields it documents. Coordinates are
// surface px: CSS px of the recorded target's viewport.
type annotationRequest struct {
	RecordingID string           `json:"recordingId"`
	Text        string           `json:"text"`
	Selector    string           `json:"selector"`
	Rect        *annotationRect  `json:"rect"`
	Point       *annotationPoint `json:"point"`
	Zoom        float64          `json:"zoom"`
	Radius      float64          `json:"radius"`
	Loops       int              `json:"loops"`
	DurationMS  int              `json:"durationMs"`
}

func (session *liveSession) handleAnnotation(w http.ResponseWriter, req *http.Request, kind string) {
	var body annotationRequest
	decoder := json.NewDecoder(req.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeWrapperError(w, http.StatusBadRequest, "invalid annotation request: "+err.Error())
		return
	}
	err := session.annotate(req.Context(), kind, body)
	switch {
	case errors.Is(err, errAnnotationInvalid):
		writeWrapperError(w, http.StatusBadRequest, err.Error())
	case err != nil:
		writeWrapperError(w, http.StatusConflict, err.Error())
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (session *liveSession) annotate(ctx context.Context, kind string, request annotationRequest) error {
	if err := validateAnnotation(kind, &request); err != nil {
		return err
	}
	r := session.runtime
	var recording *wrapperRecording
	var targetID string
	running := 0
	r.mu.Lock()
	for _, candidate := range session.recordings {
		if candidate.Status == wrapperRecordingRunning && !candidate.finalizing && (request.RecordingID == "" || candidate.ID == request.RecordingID) {
			recording, targetID = candidate, candidate.TargetID
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
	release, err := session.acquireRecordingGate(ctx)
	if err != nil {
		return err
	}
	defer release()
	var started time.Time
	var fields map[string]any
	switch kind {
	case "caption":
		started, fields = time.Now(), map[string]any{"text": request.Text, "durationMs": request.DurationMS}
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
	member := recording.Status == wrapperRecordingRunning && !recording.finalizing
	r.mu.Unlock()
	if !member {
		return errors.New("recording stopped")
	}
	recording.journal.append(journalLine(kind, started, fields))
	return nil
}

// validateAnnotation checks a request and fills its defaults, so a bad one fails before it waits for the gate.
func validateAnnotation(kind string, request *annotationRequest) error {
	invalid := func(format string, args ...any) error {
		return fmt.Errorf("%w: "+format, append([]any{errAnnotationInvalid}, args...)...)
	}
	duration := func(fallback, low, high int) error {
		if request.DurationMS == 0 {
			request.DurationMS = fallback
		} else if request.DurationMS < low || request.DurationMS > high {
			return invalid("durationMs must be %d to %d", low, high)
		}
		return nil
	}
	if kind == "caption" {
		request.Text = strings.TrimSpace(request.Text)
		if request.Text == "" || utf8.RuneCountInString(request.Text) > captionMaxRunes {
			return invalid("text must be 1 to %d characters", captionMaxRunes)
		}
		return duration(3000, 200, 30000)
	}
	if kind != "focus" && kind != "attention" {
		return invalid("unknown kind %q", kind)
	}
	if kind == "attention" && request.Point != nil {
		request.Rect = &annotationRect{X: request.Point.X, Y: request.Point.Y}
	}
	if (request.Rect == nil) == (request.Selector == "") {
		return invalid("name the place with a rect or point, or with a selector, not both")
	}
	if request.Rect != nil && (request.Rect.Width < 0 || request.Rect.Height < 0) {
		return invalid("size must not be negative")
	}
	if kind == "focus" {
		if request.Zoom <= 1 || request.Zoom > focusMaxZoom {
			return invalid("zoom must be above 1 and at most %v", focusMaxZoom)
		}
		return duration(2000, 200, 10000)
	}
	if request.Radius == 0 {
		request.Radius = 40
	}
	if request.Loops == 0 {
		request.Loops = 2
	}
	if request.Radius < 8 || request.Radius > 300 || request.Loops < 1 || request.Loops > 5 {
		return invalid("radius must be 8 to 300 and loops 1 to 5")
	}
	return duration(1200, 300, 5000)
}

// annotateFocus blocks for the duration of a zoom on a rect, so nothing else happens meanwhile.
func (session *liveSession) annotateFocus(ctx context.Context, targetID string, request annotationRequest) (time.Time, map[string]any, error) {
	rect, err := session.annotationRect(targetID, request)
	if err != nil {
		return time.Time{}, nil, err
	}
	started := time.Now()
	if err := sleepContext(ctx, time.Duration(request.DurationMS)*time.Millisecond); err != nil {
		return time.Time{}, nil, err
	}
	return started, map[string]any{"targetId": targetID, "rect": rect, "zoom": request.Zoom}, nil
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
	if err := session.pointer.circle(ctx, surface, center, request.Radius, request.Loops, time.Duration(request.DurationMS)*time.Millisecond, session.automationCadence().timing()); err != nil {
		return time.Time{}, nil, err
	}
	return started, map[string]any{"targetId": targetID, "x": center.x, "y": center.y, "radius": request.Radius, "loops": request.Loops}, nil
}

// annotationRect takes the request's rect, or resolves its selector, to a rect in surface px.
func (session *liveSession) annotationRect(targetID string, request annotationRequest) (annotationRect, error) {
	if request.Rect != nil {
		return *request.Rect, nil
	}
	quoted, _ := json.Marshal(request.Selector)
	expression := fmt.Sprintf(`(()=>{const e=document.querySelector(%s);if(!e)return null;const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`, quoted)
	var box []float64
	err := session.browser.withTarget(targetID, func(ctx context.Context) error {
		object, details, err := runtime.Evaluate(expression).WithReturnByValue(true).Do(ctx)
		if err != nil {
			return err
		}
		if details != nil {
			return fmt.Errorf("%w: selector is not valid", errAnnotationInvalid)
		}
		return json.Unmarshal(object.Value, &box)
	})
	if err != nil {
		return annotationRect{}, err
	}
	if len(box) != 4 {
		return annotationRect{}, fmt.Errorf("%w: selector matched no element", errAnnotationInvalid)
	}
	return annotationRect{X: box[0], Y: box[1], Width: box[2], Height: box[3]}, nil
}
