package agentbrowser

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

//go:embed profiles.json
var profilesJSON []byte

type Profile struct {
	Tools []string `json:"tools"`
}

type Metadata struct {
	Version  string             `json:"agent_browser_version"`
	Profiles map[string]Profile `json:"profiles"`
}

func MetadataFromEmbedded() (Metadata, error) {
	var metadata Metadata
	if err := json.Unmarshal(profilesJSON, &metadata); err != nil {
		return Metadata{}, fmt.Errorf("parse embedded agent-browser metadata: %w", err)
	}
	return metadata, nil
}

func ParseProfiles(value string) ([]string, error) {
	metadata, err := MetadataFromEmbedded()
	if err != nil {
		return nil, err
	}

	parts := strings.Split(value, ",")
	profiles := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		profile := strings.TrimSpace(part)
		if profile == "" {
			return nil, fmt.Errorf("agent-browser tool profile is empty")
		}
		if _, ok := metadata.Profiles[profile]; !ok {
			return nil, fmt.Errorf("unknown agent-browser tool profile %q", profile)
		}
		if _, ok := seen[profile]; ok {
			return nil, fmt.Errorf("agent-browser tool profile %q is repeated", profile)
		}
		seen[profile] = struct{}{}
		profiles = append(profiles, profile)
	}
	if len(profiles) == 0 {
		return nil, fmt.Errorf("agent-browser tool profiles are required")
	}
	return profiles, nil
}

func ToolsForProfiles(profiles []string) (map[string]struct{}, error) {
	metadata, err := MetadataFromEmbedded()
	if err != nil {
		return nil, err
	}
	tools := make(map[string]struct{})
	for _, profile := range profiles {
		entry, ok := metadata.Profiles[profile]
		if !ok {
			return nil, fmt.Errorf("unknown agent-browser tool profile %q", profile)
		}
		for _, tool := range entry.Tools {
			tools[tool] = struct{}{}
		}
	}
	return tools, nil
}

func SortedToolsForProfiles(profiles []string) ([]string, error) {
	tools, err := ToolsForProfiles(profiles)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(tools))
	for tool := range tools {
		result = append(result, tool)
	}
	sort.Strings(result)
	return result, nil
}
