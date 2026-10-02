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
		writeWrapperError(w, http.StatusBadRequest, "invalid annotation request")
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
	release, err := session.acquireGate(ctx)
	if err != nil {
		return err
	}
	defer release()
	r := session.runtime
	var journal *recordingJournal
	var targetID string
	running := 0
	r.mu.Lock()
	for _, recording := range session.recordings {
		if recording.Status == wrapperRecordingRunning && !recording.finalizing && (request.RecordingID == "" || recording.ID == request.RecordingID) {
			journal, targetID = recording.journal, recording.TargetID
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
	switch kind {
	case "caption":
		return session.annotateCaption(journal, request)
	case "focus":
		return session.annotateFocus(ctx, journal, targetID, request)
	case "attention":
		return session.annotateAttention(ctx, journal, targetID, request)
	}
	return fmt.Errorf("%w: unknown kind %q", errAnnotationInvalid, kind)
}

// annotationMS validates a duration in milliseconds, with a default for none.
func annotationMS(value, fallback, low, high int) (int, error) {
	if value == 0 {
		return fallback, nil
	}
	if value < low || value > high {
		return 0, fmt.Errorf("%w: durationMs must be %d to %d", errAnnotationInvalid, low, high)
	}
	return value, nil
}

// annotateCaption shows text from now for durationMs; the finalizer burns it in.
func (session *liveSession) annotateCaption(journal *recordingJournal, request annotationRequest) error {
	text := strings.TrimSpace(request.Text)
	if text == "" || utf8.RuneCountInString(text) > captionMaxRunes {
		return fmt.Errorf("%w: text must be 1 to %d characters", errAnnotationInvalid, captionMaxRunes)
	}
	duration, err := annotationMS(request.DurationMS, 3000, 200, 30000)
	if err != nil {
		return err
	}
	journal.append(journalLine("caption", time.Now(), map[string]any{"text": text, "durationMs": duration}))
	return nil
}

// annotateFocus blocks for the duration of a zoom on a rect, so nothing else happens meanwhile.
func (session *liveSession) annotateFocus(ctx context.Context, journal *recordingJournal, targetID string, request annotationRequest) error {
	if request.Zoom <= 1 || request.Zoom > focusMaxZoom {
		return fmt.Errorf("%w: zoom must be above 1 and at most %v", errAnnotationInvalid, focusMaxZoom)
	}
	duration, err := annotationMS(request.DurationMS, 2000, 200, 10000)
	if err != nil {
		return err
	}
	rect, err := session.annotationRect(targetID, request)
	if err != nil {
		return err
	}
	started := time.Now()
	if err := sleepContext(ctx, time.Duration(duration)*time.Millisecond); err != nil {
		return err
	}
	journal.append(journalLine("focus", started, map[string]any{"targetId": targetID, "rect": rect, "zoom": request.Zoom}))
	return nil
}

// annotateAttention loops the real pointer around a point so a viewer looks there.
func (session *liveSession) annotateAttention(ctx context.Context, journal *recordingJournal, targetID string, request annotationRequest) error {
	radius, loops := request.Radius, request.Loops
	if radius == 0 {
		radius = 40
	}
	if loops == 0 {
		loops = 2
	}
	if radius < 8 || radius > 300 || loops < 1 || loops > 5 {
		return fmt.Errorf("%w: radius must be 8 to 300 and loops 1 to 5", errAnnotationInvalid)
	}
	duration, err := annotationMS(request.DurationMS, 1200, 300, 5000)
	if err != nil {
		return err
	}
	rect, err := session.annotationRect(targetID, annotationRequest{Selector: request.Selector, Rect: pointRect(request.Point)})
	if err != nil {
		return err
	}
	if session.pointer == nil {
		return errors.New("attention needs a compositor session")
	}
	surface, ready := session.pointer.surface(targetID)
	if !ready {
		return errors.New("recorded target is not ready")
	}
	automation, err := session.acquireAutomation("Recording attention")
	if err != nil {
		return err
	}
	defer session.releaseAutomation(automation)
	center := cdpPoint{rect.X + rect.Width/2, rect.Y + rect.Height/2}
	started := time.Now()
	if err := session.pointer.circle(ctx, surface, center, radius, loops, time.Duration(duration)*time.Millisecond, session.automationCadence().timing()); err != nil {
		return err
	}
	journal.append(journalLine("attention", started, map[string]any{"targetId": targetID, "x": center.x, "y": center.y, "radius": radius, "loops": loops}))
	return nil
}

func pointRect(point *annotationPoint) *annotationRect {
	if point == nil {
		return nil
	}
	return &annotationRect{X: point.X, Y: point.Y}
}

// annotationRect takes the request's rect, or resolves its selector, to a rect in surface px.
func (session *liveSession) annotationRect(targetID string, request annotationRequest) (annotationRect, error) {
	if (request.Rect == nil) == (request.Selector == "") {
		return annotationRect{}, fmt.Errorf("%w: name the place with a rect or point, or with a selector, not both", errAnnotationInvalid)
	}
	if request.Rect != nil {
		if request.Rect.Width < 0 || request.Rect.Height < 0 {
			return annotationRect{}, fmt.Errorf("%w: size must not be negative", errAnnotationInvalid)
		}
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
