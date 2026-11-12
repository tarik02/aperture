package httpapi

import (
	"context"
	"io/fs"
	"path"
	"strings"

	"github.com/aperture/aperture/skills"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpGuideURIPrefix = "aperture://guide/"

const mcpCentralInstructions = `Aperture runs isolated Chromium sessions. Tools that act on a session take its sessionId.

- Start: browser.channels, then sessions.create. Use sessions.create_from_snapshot only with a snapshot the user named; a session without one is signed in nowhere.
- Status, connection, list and get tools read without waking a suspended session. Browser tools, browser.targets and recording tools wake it. sessions.reopen is only for deleted or failed sessions.
- Finish with sessions.suspend to keep the session or sessions.delete to drop it.
- To show a person a session, give them its webUrl. Don't build session links.
- An input_busy error means a person or another agent holds the browser input. Wait and retry; don't fight for it.
- File arguments and results are session file paths, not host paths. Get files out with session_files.create_download_url.
- Record: pick a ready target from browser.targets, recording.start, act, recording.stop, then poll recording.status until editing is false.

Full guide: ` + mcpGuideURIPrefix + `SKILL.md, with references under ` + mcpGuideURIPrefix + `references/. Read them with resources/read.`

const mcpBoundInstructions = `Aperture runs isolated Chromium sessions. This connection is bound to one session, so tools take no sessionId.

- Status and connection tools read without waking a suspended session. Browser tools, browser.targets and recording tools wake it.
- Finish with sessions.suspend to keep the session.
- An input_busy error means a person or another agent holds the browser input. Wait and retry; don't fight for it.
- File arguments and results are session file paths, not host paths. Get files out with session_files.create_download_url.
- Record: pick a ready target from browser.targets, recording.start, act, recording.stop, then poll recording.status until editing is false.

Full guide: ` + mcpGuideURIPrefix + `SKILL.md, with references under ` + mcpGuideURIPrefix + `references/. Read them with resources/read.`

func mcpInstructions(a mcpAuth) string {
	if a.pathBound {
		return mcpBoundInstructions
	}
	return mcpCentralInstructions
}

// addMCPGuideResources serves the Aperture skill so clients that cannot
// install skills still reach it. URIs keep the skill's layout, so its
// relative links resolve against the resource URI.
func addMCPGuideResources(server *mcp.Server) {
	root, err := fs.Sub(skills.Aperture, "aperture")
	if err != nil {
		panic("httpapi: embedded skill unavailable: " + err.Error())
	}
	err = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		content, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		text := string(content)
		uri := mcpGuideURIPrefix + name
		server.AddResource(&mcp.Resource{
			URI:         uri,
			Name:        strings.TrimSuffix(path.Base(name), ".md"),
			Title:       mcpGuideTitle(text, name),
			Description: mcpGuideDescription(name),
			MIMEType:    "text/markdown",
			Size:        int64(len(content)),
		}, func(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "text/markdown", Text: text}}}, nil
		})
		return nil
	})
	if err != nil {
		panic("httpapi: embedded skill unreadable: " + err.Error())
	}
}

func mcpGuideTitle(text, name string) string {
	for line := range strings.Lines(text) {
		if heading, ok := strings.CutPrefix(line, "# "); ok {
			return strings.TrimSpace(heading)
		}
	}
	return name
}

func mcpGuideDescription(name string) string {
	if name == "SKILL.md" {
		return "How to operate Aperture: credentials, workflows, and which reference covers what."
	}
	return "Aperture reference linked from SKILL.md."
}
