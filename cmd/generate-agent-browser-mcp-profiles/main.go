//go:build tools

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type profileMetadata struct {
	Tools []string `json:"tools"`
}

type toolMetadata struct {
	Name         string         `json:"name"`
	Title        string         `json:"title,omitempty"`
	Description  string         `json:"description,omitempty"`
	InputSchema  map[string]any `json:"inputSchema"`
	OutputSchema any            `json:"outputSchema,omitempty"`
	Annotations  any            `json:"annotations,omitempty"`
	Meta         any            `json:"_meta,omitempty"`
	Icons        any            `json:"icons,omitempty"`
}

type metadata struct {
	Version  string                     `json:"agent_browser_version"`
	Profiles map[string]profileMetadata `json:"profiles"`
	Tools    map[string]toolMetadata    `json:"tools"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: generate-agent-browser-mcp-profiles <agent-browser> <output>")
		os.Exit(2)
	}

	agentBrowser := os.Args[1]
	outputPath := os.Args[2]
	version, err := bundledVersion(agentBrowser)
	if err != nil {
		fail(err)
	}

	profileNames := []string{"all", "core", "debug", "mobile", "network", "react", "state", "tabs"}
	profiles := make(map[string]profileMetadata, len(profileNames))
	toolDefinitions := make(map[string]toolMetadata)
	for _, profile := range profileNames {
		tools, err := listTools(agentBrowser, profile)
		if err != nil {
			fail(fmt.Errorf("list %s tools: %w", profile, err))
		}
		names := make([]string, 0, len(tools))
		for _, tool := range tools {
			names = append(names, tool.Name)
			inputSchema, ok := tool.InputSchema.(map[string]any)
			if !ok {
				fail(fmt.Errorf("tool %s has invalid input schema", tool.Name))
			}
			toolDefinitions[tool.Name] = toolMetadata{Name: tool.Name, Title: tool.Title, Description: tool.Description, InputSchema: inputSchema, OutputSchema: tool.OutputSchema, Annotations: tool.Annotations, Meta: tool.Meta, Icons: tool.Icons}
		}
		profiles[profile] = profileMetadata{Tools: names}
	}
	contents, err := json.MarshalIndent(metadata{Version: version, Profiles: profiles, Tools: toolDefinitions}, "", "  ")
	if err != nil {
		fail(fmt.Errorf("encode metadata: %w", err))
	}
	contents = append(contents, '\n')
	if err := os.WriteFile(outputPath, contents, 0o644); err != nil {
		fail(fmt.Errorf("write metadata: %w", err))
	}
}

func bundledVersion(agentBrowser string) (string, error) {
	output, err := exec.Command(agentBrowser, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("run %s --version: %w", agentBrowser, err)
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "agent-browser ")
	if version == "" {
		return "", fmt.Errorf("%s returned an empty version", agentBrowser)
	}
	return version, nil
}

func listTools(agentBrowser, profile string) ([]*mcp.Tool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	client := mcp.NewClient(&mcp.Implementation{Name: "aperture-profile-generator", Version: "1.0.0"}, nil)
	transport := &mcp.CommandTransport{Command: exec.CommandContext(ctx, agentBrowser, "mcp", "--tools", profile)}
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, err
	}
	defer session.Close()

	seen := make(map[string]*mcp.Tool)
	for cursor := ""; ; {
		params := (*mcp.ListToolsParams)(nil)
		if cursor != "" {
			params = &mcp.ListToolsParams{Cursor: cursor}
		}
		result, err := session.ListTools(ctx, params)
		if err != nil {
			return nil, err
		}
		for _, tool := range result.Tools {
			seen[tool.Name] = tool
		}
		if result.NextCursor == "" {
			break
		}
		cursor = result.NextCursor
	}

	tools := make([]*mcp.Tool, 0, len(seen))
	for _, tool := range seen {
		tools = append(tools, tool)
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return tools, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
