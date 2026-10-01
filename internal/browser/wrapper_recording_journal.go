package browser

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// These functions run under the existing Playwright call mutex, shared with
// recording membership changes. The journal's browser event domain stays opaque.
func (session *liveSession) recordingCallArguments(arguments map[string]any) map[string]any {
	ids := []string{}
	cadence := "immediate"
	session.runtime.mu.Lock()
	for _, recording := range session.recordings {
		if recording.Status != wrapperRecordingRunning || recording.finalizing {
			continue
		}
		ids = append(ids, recording.ID)
		if recording.Presentation {
			cadence = "presentation"
		} else if cadence == "immediate" {
			cadence = "recorded"
		}
	}
	session.runtime.mu.Unlock()
	if cadence == "immediate" {
		session.mu.Lock()
		for _, client := range session.clients {
			if client.canRecord() && client.automationPacing == "watchable" && !client.recovering {
				cadence = "recorded"
				break
			}
		}
		session.mu.Unlock()
	}
	// Copy the public arguments and metadata; the caller cannot select private policy.
	copy := make(map[string]any, len(arguments)+1)
	for name, value := range arguments {
		copy[name] = value
	}
	meta := make(map[string]any)
	if original, ok := arguments["_meta"].(map[string]any); ok {
		for name, value := range original {
			if name != "aperture" {
				meta[name] = value
			}
		}
	}
	meta["aperture"] = struct {
		Cadence      string   `json:"cadence"`
		RecordingIDs []string `json:"recordingIds"`
	}{cadence, ids}
	copy["_meta"] = meta
	return copy
}

func (session *liveSession) consumeRecordingCallResult(ctx context.Context, result *mcp.CallToolResult) {
	metadata, exists := result.Meta["aperture"]
	delete(result.Meta, "aperture")
	if !exists {
		session.markRecordingSourcesIncomplete("browser result has no recording metadata")
		return
	}
	// The SDK decodes MCP metadata to JSON values. Decode only this routing envelope,
	// never the encoded event lines inside it, and never round-trip observations.
	envelope, valid := metadata.(map[string]any)
	if !valid {
		session.markRecordingSourcesIncomplete("invalid browser journal envelope")
		return
	}
	warnings, valid := envelope["warnings"].([]any)
	if !valid {
		session.markRecordingSourcesIncomplete("invalid browser journal warnings")
		return
	}
	for _, warning := range warnings {
		text, valid := warning.(string)
		if !valid {
			text = "invalid browser journal warning"
		}
		session.markRecordingSourcesIncomplete(text)
	}
	journal, valid := envelope["journal"].([]any)
	if !valid {
		session.markRecordingSourcesIncomplete("invalid browser journal routing")
		return
	}
	for _, entry := range journal {
		route, valid := entry.(map[string]any)
		if !valid {
			session.markRecordingSourcesIncomplete("invalid browser journal route")
			continue
		}
		id, validID := route["recordingId"].(string)
		line, validLine := route["line"].(string)
		if !validID || !validLine || strings.ContainsAny(line, "\r\n") {
			session.markRecordingSourcesIncomplete("invalid browser journal line")
			continue
		}
		session.runtime.mu.Lock()
		recording := session.recordings[id]
		active := recording != nil && recording.Status == wrapperRecordingRunning && !recording.finalizing
		session.runtime.mu.Unlock()
		if !active {
			continue
		}
		if _, err := recording.actions.WriteString(line + "\n"); err != nil {
			session.runtime.mu.Lock()
			recording.actionsComplete = false
			recording.sourceWarnings = append(recording.sourceWarnings, "browser journal append failed")
			session.runtime.mu.Unlock()
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: recording journal %s: %v\n", id, err)
		}
	}
	if targetID, ok := envelope["endTargetId"].(string); ok && targetID != "" {
		session.followBurstRecordings(ctx, targetID)
	}
}

func (session *liveSession) followBurstRecordings(ctx context.Context, targetID string) {
	session.runtime.mu.Lock()
	registry := session.runtime.targets
	recordings := []*wrapperRecording{}
	for _, recording := range session.recordings {
		if recording.Capture == "bursts" && recording.Status == wrapperRecordingRunning && !recording.finalizing && recording.TargetID != targetID {
			recordings = append(recordings, recording)
		}
	}
	session.runtime.mu.Unlock()
	if len(recordings) == 0 {
		return
	}
	target, ready := registry.readyTarget(targetID)
	if !ready {
		session.markRecordingSourcesIncomplete("burst destination is not ready")
		return
	}
	for _, recording := range recordings {
		recording.operationMu.Lock()
		session.runtime.mu.Lock()
		previous := recording.TargetID
		session.runtime.mu.Unlock()
		err := session.rotateRecordingTargetLocked(ctx, recording, target, previous, true)
		recording.operationMu.Unlock()
		if err != nil {
			session.runtime.mu.Lock()
			recording.actionsComplete = false
			recording.sourceWarnings = append(recording.sourceWarnings, "burst target could not follow browser automation")
			session.runtime.mu.Unlock()
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: burst recording %s: %v\n", recording.ID, err)
		}
	}
	session.broadcastRecordings()
}

func (session *liveSession) markRecordingSourcesIncomplete(warning string) {
	session.runtime.mu.Lock()
	defer session.runtime.mu.Unlock()
	for _, recording := range session.recordings {
		if recording.Status == wrapperRecordingRunning && !recording.finalizing {
			recording.actionsComplete = false
			recording.sourceWarnings = append(recording.sourceWarnings, warning)
		}
	}
}

func recordingRelativeArtifact(recording *wrapperRecording, file string) string {
	relative, _ := filepath.Rel(recording.filesRoot, file)
	return filepath.ToSlash(relative)
}
