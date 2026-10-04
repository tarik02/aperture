package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"

	"github.com/aperture/aperture/internal/recording"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpRecordingError turns an error of the recording path into the tool's code: invalid arguments,
// the recording's state, or a wrapper that could not be reached.
func mcpRecordingError(err error) error {
	switch {
	case errors.Is(err, recording.ErrInvalid):
		return mcpToolError("invalid_arguments", err)
	case errors.Is(err, errRecordingNotFound):
		return mcpToolError("recording_not_found", err)
	case errors.Is(err, errRecordingInvalidState):
		return mcpToolError("recording_invalid_state", err)
	case errors.Is(err, errRecordingCodecUnavailable):
		return mcpToolError("recording_codec_unavailable", err)
	default:
		return mcpToolError("recording_unavailable", err)
	}
}

// mcpSchema builds a tool's input schema once; the server is rebuilt per MCP session.
func mcpSchema[In any](adjust func(*jsonschema.Schema)) func() *jsonschema.Schema {
	return sync.OnceValue(func() *jsonschema.Schema {
		schema, err := jsonschema.For[In](nil)
		if err != nil {
			panic(err)
		}
		if adjust != nil {
			adjust(schema)
		}
		return schema
	})
}

// recordingStartSchema says in the schema what recording.Config.Validate checks, which the struct
// tags cannot: the enums and the burst bounds.
func recordingStartSchema(schema *jsonschema.Schema) {
	schema.Properties["capture"].Enum = []any{recording.CaptureContinuous, recording.CaptureBursts}
	schema.Properties["idle"].Enum = []any{recording.IdleCut, recording.IdleSpeed}
	for _, field := range schema.Properties["burst"].Properties {
		field.Minimum = jsonschema.Ptr(0.0)
		field.Maximum = jsonschema.Ptr(float64(recording.BurstMaxMS))
	}
}

// sessionAddressed adds the session address to a tool's schema when its path does not bind one.
func sessionAddressed(schema *jsonschema.Schema) {
	schema.Properties["tenantId"] = &jsonschema.Schema{Type: "string"}
	schema.Properties["sessionId"] = &jsonschema.Schema{Type: "string", Description: "Aperture session ID."}
	schema.Required = append(schema.Required, "sessionId")
}

func annotationDurationSchema(field *jsonschema.Schema, fallback, low, high float64) {
	field.Default, _ = json.Marshal(fallback)
	field.AnyOf = []*jsonschema.Schema{
		{Const: jsonschema.Ptr[any](0)},
		{Minimum: jsonschema.Ptr(low), Maximum: jsonschema.Ptr(high)},
	}
}

func captionSchema(schema *jsonschema.Schema) {
	schema.Properties["text"].MinLength = jsonschema.Ptr(1)
	schema.Properties["text"].MaxLength = jsonschema.Ptr(recording.CaptionMaxRunes)
	annotationDurationSchema(schema.Properties["durationMs"], recording.CaptionDurationDefaultMS, recording.CaptionDurationMinMS, recording.CaptionDurationMaxMS)
}

func focusSchema(schema *jsonschema.Schema) {
	schema.Properties["zoom"].ExclusiveMinimum = jsonschema.Ptr(1.0)
	schema.Properties["zoom"].Maximum = jsonschema.Ptr(recording.FocusMaxZoom)
	annotationDurationSchema(schema.Properties["durationMs"], recording.FocusDurationDefaultMS, recording.FocusDurationMinMS, recording.FocusDurationMaxMS)
}

func attentionSchema(schema *jsonschema.Schema) {
	annotationDurationSchema(schema.Properties["radius"], recording.AttentionRadiusDefault, recording.AttentionRadiusMin, recording.AttentionRadiusMax)
	annotationDurationSchema(schema.Properties["loops"], recording.AttentionLoopsDefault, recording.AttentionLoopsMin, recording.AttentionLoopsMax)
	annotationDurationSchema(schema.Properties["durationMs"], recording.AttentionDurationDefaultMS, recording.AttentionDurationMinMS, recording.AttentionDurationMaxMS)
}

func addressedAnnotation(adjust func(*jsonschema.Schema)) func(*jsonschema.Schema) {
	return func(schema *jsonschema.Schema) {
		adjust(schema)
		sessionAddressed(schema)
	}
}

var (
	mcpRecordingStartSchema      = mcpSchema[mcpRecordingStartInput](recordingStartSchema)
	mcpBoundRecordingStartSchema = mcpSchema[mcpBoundRecordingStartInput](recordingStartSchema)
	mcpCaptionSchema             = mcpSchema[recording.Caption](addressedAnnotation(captionSchema))
	mcpBoundCaptionSchema        = mcpSchema[recording.Caption](captionSchema)
	mcpFocusSchema               = mcpSchema[recording.Focus](addressedAnnotation(focusSchema))
	mcpBoundFocusSchema          = mcpSchema[recording.Focus](focusSchema)
	mcpAttentionSchema           = mcpSchema[recording.Attention](addressedAnnotation(attentionSchema))
	mcpBoundAttentionSchema      = mcpSchema[recording.Attention](attentionSchema)
)

// addRecordingAnnotationTool adds one explicit recording tool, session-addressed or bound to the
// session of its path. Its arguments are checked here, and the recording must already be running,
// so a suspended session is never woken for one.
func addRecordingAnnotationTool[Args any, PArgs interface {
	*Args
	Validate() error
}](s *Server, server *mcp.Server, kind, description string, schema *jsonschema.Schema) {
	server.AddTool(&mcp.Tool{Name: "recording." + kind, Description: description, InputSchema: schema}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		a, err := mcpAuthFromContext(ctx)
		if err != nil {
			return nil, err
		}
		arguments := map[string]json.RawMessage{}
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &arguments); err != nil {
				return nil, mcpToolError("invalid_arguments", err)
			}
		}
		var sessionID, tenantID string
		for name, into := range map[string]*string{"sessionId": &sessionID, "tenantId": &tenantID} {
			if raw, ok := arguments[name]; ok {
				if err := json.Unmarshal(raw, into); err != nil {
					return nil, mcpToolError("invalid_arguments", err)
				}
				delete(arguments, name)
			}
		}
		encoded, err := json.Marshal(arguments)
		if err != nil {
			return nil, mcpToolError("invalid_arguments", err)
		}
		var args Args
		if err := json.Unmarshal(encoded, &args); err != nil {
			return nil, mcpToolError("invalid_arguments", err)
		}
		if err := PArgs(&args).Validate(); err != nil {
			return nil, mcpToolError("invalid_arguments", err)
		}
		view, err := s.sessionForMCP(ctx, &a, sessionID, tenantID, true)
		if err != nil {
			return nil, err
		}
		if err := s.recordingAnnotation(ctx, view.Session.TenantID, view.Session.ID, kind, args); err != nil {
			return nil, mcpRecordingError(err)
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil
	})
}

func (s *Server) addRecordingAnnotationTools(server *mcp.Server, a mcpAuth) {
	pick := func(addressed, bound func() *jsonschema.Schema) *jsonschema.Schema {
		if a.pathBound {
			return bound()
		}
		return addressed()
	}
	addRecordingAnnotationTool[recording.Caption](s, server, "caption", "Show a caption in the recording from now on. Returns at once.", pick(mcpCaptionSchema, mcpBoundCaptionSchema))
	addRecordingAnnotationTool[recording.Focus](s, server, "focus", "Zoom the recording on a rect or element for a while. Blocks for the duration, so no browser tool runs meanwhile.", pick(mcpFocusSchema, mcpBoundFocusSchema))
	addRecordingAnnotationTool[recording.Attention](s, server, "attention", "Circle the real pointer around a point or element so a viewer looks there. Blocks for the duration. Needs a compositor session.", pick(mcpAttentionSchema, mcpBoundAttentionSchema))
}

func (s *Server) mcpRecordingStart(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingStartInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	if err := s.checkRecordingConfig(&in.Config); err != nil {
		return nil, mcpRecordingOutput{}, mcpRecordingError(err)
	}
	view, err := s.sessionForMCP(ctx, &a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, "/recordings", wrapperRecordingStart{
		Mode: "tab", TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec, Config: in.Config,
	}, false)
}

func (s *Server) mcpRecordingsList(ctx context.Context, _ *mcp.CallToolRequest, in mcpSessionIDInput) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingsOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, &a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingsOutput{}, err
	}
	return s.mcpRecordingsRequest(ctx, view.Session.TenantID, view.Session.ID)
}

func (s *Server) mcpRecordingStatus(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, &a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, "/recordings/"+url.PathEscape(in.RecordingID), nil, false)
}

// mcpRecordingStop returns as soon as the raw video is published; the recording is editing until
// its edit is over.
func (s *Server) mcpRecordingStop(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, &a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	path := "/recordings/" + url.PathEscape(in.RecordingID)
	if _, _, err := s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, path+"/stop", nil, true); err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodGet, path, nil, false)
}

func (s *Server) mcpRecordingRetarget(ctx context.Context, _ *mcp.CallToolRequest, in mcpRecordingRetargetInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	view, err := s.sessionForMCP(ctx, &a, in.SessionID, in.TenantID, true)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	path := "/recordings/" + url.PathEscape(in.RecordingID) + "/retarget"
	return s.mcpRecordingRequest(ctx, view.Session.TenantID, view.Session.ID, http.MethodPost, path, map[string]string{"targetId": in.TargetID}, false)
}

func (s *Server) mcpBoundRecordingStart(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingStartInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStart(ctx, req, mcpRecordingStartInput{TenantID: a.tenantID, SessionID: a.sessionID, TargetID: in.TargetID, FPS: in.FPS, BitrateKbps: in.BitrateKbps, Codec: in.Codec, Config: in.Config})
}

func (s *Server) mcpBoundRecordingsList(ctx context.Context, req *mcp.CallToolRequest, _ mcpSessionOnlyInput) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingsOutput{}, err
	}
	return s.mcpRecordingsList(ctx, req, mcpSessionIDInput{TenantID: a.tenantID, SessionID: a.sessionID})
}

func (s *Server) mcpBoundRecordingStatus(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStatus(ctx, req, mcpRecordingInput{TenantID: a.tenantID, SessionID: a.sessionID, RecordingID: in.RecordingID})
}

func (s *Server) mcpBoundRecordingStop(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingStop(ctx, req, mcpRecordingInput{TenantID: a.tenantID, SessionID: a.sessionID, RecordingID: in.RecordingID})
}

func (s *Server) mcpBoundRecordingRetarget(ctx context.Context, req *mcp.CallToolRequest, in mcpBoundRecordingRetargetInput) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	a, err := mcpAuthFromContext(ctx)
	if err != nil {
		return nil, mcpRecordingOutput{}, err
	}
	return s.mcpRecordingRetarget(ctx, req, mcpRecordingRetargetInput{
		TenantID: a.tenantID, SessionID: a.sessionID, RecordingID: in.RecordingID, TargetID: in.TargetID,
	})
}

func (s *Server) mcpRecordingRequest(ctx context.Context, tenantID, sessionID, method, path string, body any, stop bool) (*mcp.CallToolResult, mcpRecordingOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	if stop {
		if err := requestWrapperRecording(ctx, port, method, path, body, true, nil); err != nil {
			return nil, mcpRecordingOutput{}, mcpRecordingError(err)
		}
		return nil, mcpRecordingOutput{}, nil
	}
	var status wrapperRecordingStatus
	if err := requestWrapperRecording(ctx, port, method, path, body, false, &status); err != nil {
		return nil, mcpRecordingOutput{}, mcpRecordingError(err)
	}
	output, err := s.mcpRecordingOutputFromStatus(sessionID, status)
	if err != nil {
		return nil, mcpRecordingOutput{}, mcpRecordingError(err)
	}
	return nil, output, nil
}

func (s *Server) mcpRecordingsRequest(ctx context.Context, tenantID, sessionID string) (*mcp.CallToolResult, mcpRecordingsOutput, error) {
	port, release, err := s.Sessions.AcquireWrapperPort(ctx, tenantID, sessionID)
	if err != nil {
		return nil, mcpRecordingsOutput{}, mcpToolError("session_unavailable", err)
	}
	defer release()
	var statuses []wrapperRecordingStatus
	if err := requestWrapperRecording(ctx, port, http.MethodGet, "/recordings", nil, false, &statuses); err != nil {
		return nil, mcpRecordingsOutput{}, mcpRecordingError(err)
	}
	output := mcpRecordingsOutput{Recordings: make([]mcpRecordingOutput, 0, len(statuses))}
	for _, status := range statuses {
		recording, err := s.mcpRecordingOutputFromStatus(sessionID, status)
		if err != nil {
			return nil, mcpRecordingsOutput{}, mcpRecordingError(err)
		}
		output.Recordings = append(output.Recordings, recording)
	}
	return nil, output, nil
}

func (s *Server) mcpRecordingOutputFromStatus(sessionID string, status wrapperRecordingStatus) (mcpRecordingOutput, error) {
	relativePath, err := s.recordingRelativePath(sessionID, status)
	if err != nil {
		return mcpRecordingOutput{}, err
	}
	return mcpRecordingOutput{
		recordingEdit: s.recordingEdit(status), RecordingID: status.RecordingID, Mode: status.Mode, TargetID: status.TargetID, CaptureGeneration: status.CaptureGeneration,
		Status: status.Status, StopReason: status.StopReason, StartedAt: status.StartedAt, StoppedAt: status.StoppedAt,
		RelativePath: relativePath, SizeBytes: status.SizeBytes, FPS: status.FPS, BitrateKbps: status.BitrateKbps, Codec: status.Codec,
	}, nil
}
