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

const mcpGuidePointer = `

Before using these tools, read the guide at ` + mcpGuideURIPrefix + `SKILL.md (resources/read). It explains the tools, credentials and workflows, and links references under ` + mcpGuideURIPrefix + `references/.`

const mcpCentralInstructions = `Aperture hosts isolated remote Chromium sessions: browsers to automate, record, share with people, or start from a saved, signed-in snapshot. Use it for browser work that needs a separate or remote browser.` + mcpGuidePointer

const mcpBoundInstructions = `Aperture hosts isolated remote Chromium sessions. This connection controls one of them: automate it, record it, and move files in and out of it.` + mcpGuidePointer

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
