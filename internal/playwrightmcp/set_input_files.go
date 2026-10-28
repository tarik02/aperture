package playwrightmcp

// SetInputFilesTool is an Aperture tool served through Playwright MCP. It puts
// session files on a file input directly, so it works for hidden inputs and inputs
// that upload on change, where browser_file_upload needs a file chooser first.
const SetInputFilesTool = "browser_set_input_files"

// RunCodeTool is the Playwright MCP tool SetInputFilesTool runs on. It is not
// exposed to clients.
const RunCodeTool = "browser_run_code_unsafe"

// SetInputFilesDefinition describes SetInputFilesTool in the shape of a Playwright tool.
func SetInputFilesDefinition() Tool {
	return Tool{
		Name:  SetInputFilesTool,
		Title: "Set input files",
		Description: "Put session files on an <input type=file> without opening a file chooser. " +
			"Works for hidden inputs and inputs that upload on change, and for files of any size. " +
			"It checks that the page can read every file and clears the input when it cannot.",
		InputSchema: map[string]any{
			"$schema": "https://json-schema.org/draft/2020-12/schema",
			"type":    "object",
			"properties": map[string]any{
				"element": map[string]any{
					"type":        "string",
					"description": "Human-readable element description used to obtain permission to interact with the element",
				},
				"target": map[string]any{
					"type":        "string",
					"description": "Exact target element reference from the page snapshot, or a unique element selector, of the file input",
				},
				"paths": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Session file relative paths, such as uploads/report.pdf, as returned by session_files.list. An empty list clears the input.",
				},
			},
			"required":             []string{"target", "paths"},
			"additionalProperties": false,
		},
		Annotations: map[string]any{
			"title":           "Set input files",
			"destructiveHint": true,
			"openWorldHint":   true,
		},
	}
}
