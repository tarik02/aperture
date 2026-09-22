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

	"github.com/aperture/aperture/internal/playwrightmcp"
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
	Version  string                     `json:"playwright_mcp_version"`
	Profiles map[string]profileMetadata `json:"profiles"`
	Tools    map[string]toolMetadata    `json:"tools"`
}

var blockedTools = map[string]struct{}{
	"browser_close":           {},
	"browser_install":         {},
	"browser_run_code":        {},
	"browser_run_code_unsafe": {},
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: generate-playwright-mcp-profiles <playwright-mcp> <output>")
		os.Exit(2)
	}

	playwrightMCP := os.Args[1]
	outputPath := os.Args[2]
	version, err := bundledVersion(playwrightMCP)
	if err != nil {
		fail(err)
	}

	profileSpecs := playwrightmcp.ProfileSpecs()
	profiles := make(map[string]profileMetadata, len(profileSpecs))
	toolDefinitions := make(map[string]toolMetadata)
	coreTools := make(map[string]struct{})
	for _, profile := range profileSpecs {
		tools, err := listTools(playwrightMCP, profile.Capability)
		if err != nil {
			fail(fmt.Errorf("list %s tools: %w", profile.Name, err))
		}
		names := make([]string, 0, len(tools))
		for _, tool := range tools {
			if _, blocked := blockedTools[tool.Name]; blocked {
				continue
			}
			if profile.Name != "core" {
				if _, core := coreTools[tool.Name]; core {
					continue
				}
			}
			inputSchema, ok := tool.InputSchema.(map[string]any)
			if !ok {
				fail(fmt.Errorf("tool %s has invalid input schema", tool.Name))
			}
			names = append(names, tool.Name)
			toolDefinitions[tool.Name] = toolMetadata{
				Name: tool.Name, Title: tool.Title, Description: tool.Description,
				InputSchema: inputSchema, OutputSchema: tool.OutputSchema,
				Annotations: tool.Annotations, Meta: tool.Meta, Icons: tool.Icons,
			}
			if profile.Name == "core" {
				coreTools[tool.Name] = struct{}{}
			}
		}
		profiles[profile.Name] = profileMetadata{Tools: names}
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

func bundledVersion(playwrightMCP string) (string, error) {
	output, err := exec.Command(playwrightMCP, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("run %s --version: %w", playwrightMCP, err)
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "Version ")
	if version == "" {
		return "", fmt.Errorf("%s returned an empty version", playwrightMCP)
	}
	return version, nil
}

func listTools(playwrightMCP, capability string) ([]*mcp.Tool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	args := []string{"--cdp-endpoint", "http://127.0.0.1:1", "--no-webmcp"}
	if capability != "" {
		args = append(args, "--caps", capability)
	}
	command := exec.CommandContext(ctx, playwrightMCP, args...)
	command.Stderr = os.Stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "aperture-profile-generator", Version: "1.0.0"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
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
