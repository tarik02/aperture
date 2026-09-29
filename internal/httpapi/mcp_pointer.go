package httpapi

import (
	"context"
	"maps"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Aperture provides these pointer tools itself. They take the names of the
// Playwright MCP tools they replace, which the browser tool profiles do not
// expose.
const (
	mcpToolBrowserClick  = "browser_click"
	mcpToolBrowserMove   = "browser_move"
	mcpToolBrowserDrag   = "browser_drag"
	mcpToolBrowserScroll = "browser_scroll"
)

func isPointerTool(name string) bool {
	switch name {
	case mcpToolBrowserClick, mcpToolBrowserMove, mcpToolBrowserDrag, mcpToolBrowserScroll:
		return true
	default:
		return false
	}
}

const mcpPointerMotionDescription = `How the pointer travels. "natural" (the default) is an eased, slightly curved glide at about 1200 px/s, "fast" is a quicker glide, and "instant" jumps in one step. An object sets an average speed, {"speed": px/s}, or a fixed travel time, {"durationMs": ms}. A value here overrides the recording and session defaults (see cursor.set). It has no effect when Playwright input is used.`

func mcpPointerMotionSchema(description string) map[string]any {
	return map[string]any{
		"description": description,
		"oneOf": []any{
			map[string]any{"type": "string", "enum": []any{"natural", "fast", "instant"}},
			map[string]any{
				"type": "object", "additionalProperties": false, "required": []any{"speed"},
				"properties": map[string]any{"speed": map[string]any{"type": "number", "minimum": 10, "maximum": 100000}},
			},
			map[string]any{
				"type": "object", "additionalProperties": false, "required": []any{"durationMs"},
				"properties": map[string]any{"durationMs": map[string]any{"type": "number", "minimum": 0, "maximum": 30000}},
			},
		},
	}
}

func mcpNumberProperty(description string) map[string]any {
	return map[string]any{"type": "number", "minimum": 0, "description": description}
}

// mcpPointerPosition returns the properties that locate a position by snapshot
// ref or by viewport coordinates. prefix names the drag endpoints; "" gives target,
// element, x and y.
func mcpPointerPosition(prefix string, what string) map[string]any {
	name := func(base string) string {
		if prefix == "" {
			return base
		}
		return prefix + strings.ToUpper(base[:1]) + base[1:]
	}
	return map[string]any{
		name("target"):  map[string]any{"type": "string", "description": "Exact target element reference from the page snapshot, or a unique element selector. Use this or " + name("x") + " and " + name("y") + "."},
		name("element"): map[string]any{"type": "string", "description": "Human-readable description of the " + what + " element, for the permission prompt."},
		name("x"):       mcpNumberProperty("Viewport X coordinate in CSS pixels, from the left edge of the page. Use with " + name("y") + " instead of " + name("target") + "."),
		name("y"):       mcpNumberProperty("Viewport Y coordinate in CSS pixels, from the top edge of the page. Use with " + name("x") + " instead of " + name("target") + "."),
	}
}

// mcpPointerCommonProperties are the parameters shared by the pointer tools;
// includeMotion adds motion, which the tools that travel a pointer path take.
func mcpPointerCommonProperties(includeMotion bool) map[string]any {
	properties := map[string]any{
		"holdMs": map[string]any{"type": "number", "minimum": 0, "maximum": 30000, "description": "Milliseconds to wait after the gesture, before the page state is returned. Use it to let a recording show the result. Defaults to 0."},
		"caption": map[string]any{
			"type": "string", "maxLength": 500,
			"description": "Short text describing the gesture, kept with the gesture's record for recordings.",
		},
		"timeoutMs": map[string]any{"type": "number", "minimum": 1, "maximum": 20000, "description": "How long to wait for a ref target to be visible, stable, enabled and not covered by another element. Defaults to 5000."},
	}
	if includeMotion {
		properties["motion"] = mcpPointerMotionSchema(mcpPointerMotionDescription)
	}
	return properties
}

// pointerToolDefinition builds one pointer tool. Path-bound connections take the
// session from the URL; the others add a required sessionId, as Playwright tools do.
func pointerToolDefinition(name, title, description string, properties map[string]any, pathBound bool) *mcp.Tool {
	all := mcpPointerCommonProperties(name != mcpToolBrowserScroll)
	maps.Copy(all, properties)
	schema := map[string]any{"type": "object", "additionalProperties": false, "properties": all}
	if !pathBound {
		all["sessionId"] = map[string]any{"type": "string", "description": "Aperture session ID."}
		schema["required"] = []any{"sessionId"}
	}
	destructive, openWorld := true, true
	return &mcp.Tool{
		Name:        name,
		Title:       title,
		Description: description,
		InputSchema: schema,
		Annotations: &mcp.ToolAnnotations{Title: title, DestructiveHint: &destructive, OpenWorldHint: &openWorld},
	}
}

func pointerToolDefinitions(pathBound bool) []*mcp.Tool {
	click := mcpPointerPosition("", "target")
	click["button"] = map[string]any{"type": "string", "enum": []any{"left", "right", "middle"}, "description": "Button to click, defaults to left."}
	click["clickCount"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 3, "description": "Number of clicks, defaults to 1. Use 2 for a double click."}
	click["doubleClick"] = map[string]any{"type": "boolean", "description": "Deprecated alias for clickCount 2, kept for Playwright's browser_click. Prefer clickCount."}
	click["modifiers"] = map[string]any{
		"type": "array", "items": map[string]any{"type": "string", "enum": []any{"Alt", "Control", "ControlOrMeta", "Meta", "Shift"}},
		"description": "Modifier keys held during the click.",
	}

	drag := mcpPointerPosition("start", "source")
	maps.Copy(drag, mcpPointerPosition("end", "destination"))

	scroll := mcpPointerPosition("", "scroll")
	scroll["target"] = map[string]any{"type": "string", "description": "Exact target element reference from the page snapshot, or a unique element selector, to scroll over. Use this or x and y. Without either, the wheel turns where the pointer last was on the page (the viewport center if it has not been there)."}
	scroll["deltaX"] = map[string]any{"type": "number", "description": "Horizontal scroll distance in CSS pixels; positive scrolls right. Defaults to 0."}
	scroll["deltaY"] = map[string]any{"type": "number", "description": "Vertical scroll distance in CSS pixels; positive scrolls down. Defaults to 0."}

	return []*mcp.Tool{
		pointerToolDefinition(mcpToolBrowserClick, "Click",
			"Click an element or a viewport position with the mouse. The pointer glides to the target and clicks with real mouse input, so the click shows in the live stream and in recordings. Pass a snapshot ref (target) or viewport coordinates (x and y). A ref target is scrolled into view and waited on until it is visible, stable, enabled and not covered.",
			click, pathBound),
		pointerToolDefinition(mcpToolBrowserMove, "Move mouse",
			"Move the mouse over an element or a viewport position, for example to open a hover menu. The pointer glides to the target. Pass a snapshot ref (target) or viewport coordinates (x and y).",
			mcpPointerPosition("", "target"), pathBound),
		pointerToolDefinition(mcpToolBrowserDrag, "Drag mouse",
			"Drag with the left mouse button from one element or viewport position to another, for drag and drop or sliders. Give the start as startTarget or startX and startY, and the end as endTarget or endX and endY.",
			drag, pathBound),
		pointerToolDefinition(mcpToolBrowserScroll, "Scroll mouse wheel",
			"Turn the mouse wheel over an element or a viewport position to scroll by a distance in CSS pixels. The page animates the scroll itself; there is no cursor travel, so this tool takes no motion. Pass a snapshot ref (target) or viewport coordinates (x and y).",
			scroll, pathBound),
	}
}

// addPointerTools registers the pointer tools. They run in the session's
// wrapper under the automation lease, like the proxied Playwright tools.
func (s *Server) addPointerTools(server *mcp.Server, a mcpAuth) {
	for _, tool := range pointerToolDefinitions(a.pathBound) {
		name := tool.Name
		handler := s.automationToolHandler(a, a.pathBound, "pointer_error", func(ctx context.Context, wrapperPort int, controlToken string, arguments map[string]any) (*mcp.CallToolResult, error) {
			return callWrapperTool(ctx, wrapperPort, controlToken, "/automation/pointer", "pointer tool", name, arguments, s.Config.ToolOutputMaxBytes)
		})
		server.AddTool(tool, handler)
	}
}
