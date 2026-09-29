package httpapi

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/aperture/aperture/internal/recording/edit"
	"github.com/aperture/aperture/internal/recording/timeline"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Recording effects are declared on the actions that make them. A recording
// applies them when it stops: a caption is burned into the video, a zoomed
// gesture zooms toward where it happens, a rippled click is marked, and idle
// stretches are sped up or cut out.

// playwrightCaptionTools are the Playwright tools that change the page, and so
// take a caption. The browser tool profiles of read-only tools do not: there is
// nothing to caption in a snapshot. This list is kept here for now and is to
// be unified with the recording bursts' classification of page-changing tools.
var playwrightCaptionTools = map[string]bool{
	"browser_navigate":      true,
	"browser_navigate_back": true,
	"browser_type":          true,
	"browser_press_key":     true,
	"browser_select_option": true,
	"browser_fill_form":     true,
	"browser_file_upload":   true,
	"browser_handle_dialog": true,
	"browser_drop":          true,
	"browser_tabs":          true,
	"browser_evaluate":      true,
	"browser_resize":        true,
	"browser_emulate_media": true,
	"browser_wait_for":      true,
}

const mcpCaptionDescription = "Short text for the recording to show while this runs, burned into the edited video. Ignored when nothing is recording."

func mcpCaptionProperty(description string) map[string]any {
	return map[string]any{"type": "string", "maxLength": edit.MaxCaptionLength, "description": description}
}

// mcpZoomSchema describes the zoom argument: true, false or a magnification.
func mcpZoomSchema(description string) map[string]any {
	return map[string]any{
		"description": description,
		"oneOf": []any{
			map[string]any{"type": "boolean"},
			map[string]any{"type": "number", "minimum": edit.MinZoomLevel, "maximum": edit.MaxZoomLevel},
		},
	}
}

const (
	mcpZoomGestureDescription = "Zoom the recording's edited video toward this gesture: true for a magnification of 1.6, a number from 1.1 to 4 for another, or false to keep it out when the recording zooms by default. Gestures close together share one zoom that pans between them. Has no effect on a gesture without a position in the video, which one made through Playwright input is."
	mcpRippleClickDescription = "Mark this click with a ripple in the recording's edited video; false keeps it out when the recording ripples by default."
	mcpZoomStartDescription   = "Zoom the edited video toward click, drag and scroll gestures that do not say otherwise with their own zoom: true for a magnification of 1.6, or a number from 1.1 to 4. Default off."
)

// mcpRecordingEffectsProperties are the effect defaults recording.start takes.
func mcpRecordingEffectsProperties() map[string]any {
	return map[string]any{
		"idle": map[string]any{
			"type": "string", "enum": []any{timeline.IdleSpeed, timeline.IdleCut},
			"description": `Shorten the stretches of the recording where nothing changes on the screen and no gesture is made: "speed" plays them faster, "cut" removes them. Default off.`,
		},
		"ripple": map[string]any{"type": "boolean", "description": "Mark clicks with a ripple in the edited video, unless the click says otherwise. Default off."},
		"zoom":   mcpZoomSchema(mcpZoomStartDescription),
	}
}

// playwrightToolCaption takes the caption out of a proxied tool's arguments,
// which Playwright would reject, and returns it.
func playwrightToolCaption(name string, arguments map[string]any) (string, error) {
	if !playwrightCaptionTools[name] {
		return "", nil
	}
	value, present := arguments["caption"]
	if !present {
		return "", nil
	}
	delete(arguments, "caption")
	caption, ok := value.(string)
	if !ok {
		return "", mcpToolError("invalid_arguments", errors.New("caption must be a string"))
	}
	if utf8.RuneCountInString(caption) > edit.MaxCaptionLength {
		return "", mcpToolError("invalid_arguments", fmt.Errorf("caption must be at most %d characters", edit.MaxCaptionLength))
	}
	return caption, nil
}

// addCaptionProperty adds the caption parameter to the schema of a tool that
// changes the page.
func addCaptionProperty(name string, properties map[string]any) {
	if playwrightCaptionTools[name] && properties != nil {
		properties["caption"] = mcpCaptionProperty(mcpCaptionDescription)
	}
}

func callPlaywrightCaptioned(ctx context.Context, port int, controlToken, name, caption string, arguments map[string]any, maxResponseBytes int64) (*mcp.CallToolResult, error) {
	extra := map[string]any{}
	if caption != "" {
		extra["caption"] = caption
	}
	return callWrapperToolWith(ctx, port, controlToken, "/automation/playwright", "Playwright MCP", name, arguments, extra, maxResponseBytes)
}

// recordingEffectsRequest is what recording.start and the REST API take to apply
// effects to the recording's video: the idle mode, and the defaults of ripple and
// zoom for gestures that do not say otherwise.
type recordingEffectsRequest struct {
	Idle   string     `json:"idle,omitempty"`
	Ripple *bool      `json:"ripple,omitempty"`
	Zoom   *edit.Zoom `json:"zoom,omitempty"`
}

func (r recordingEffectsRequest) validate() error {
	switch r.Idle {
	case "", timeline.IdleSpeed, timeline.IdleCut:
		return nil
	default:
		return validationError(`idle must be "speed" or "cut"`)
	}
}

// wrapperFields adds the effects to the wrapper's recording request.
func (r recordingEffectsRequest) wrapperFields(request map[string]any) {
	if r.Idle != "" {
		request["idle"] = r.Idle
	}
	if r.Ripple != nil {
		request["ripple"] = *r.Ripple
	}
	if r.Zoom != nil {
		request["zoom"] = *r.Zoom
	}
}

// recordingEditError says why a recording has no edited video although it has
// effects to apply.
type recordingEditError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
