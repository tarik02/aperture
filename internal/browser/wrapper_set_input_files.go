package browser

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
)

// snapshotRefPattern matches the element references Playwright MCP snapshots
// assign, optionally prefixed with a frame, as its own tools recognize them.
var snapshotRefPattern = regexp.MustCompile(`^(f\d+)?e\d+$`)

type inputFileExpectation struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// setInputFilesCode builds the Playwright code that runs browser_set_input_files.
// Paths stay relative: Playwright MCP resolves them against its working
// directory, the session files root, so no host path reaches the tool output.
//
// Chromium gives the page read access to the files when it sets them. A page
// without that access sees each file with size 0, and Chromium kills the tab once
// the page uses the file, so a size mismatch clears the input and fails the call.
func setInputFilesCode(filesDir string, arguments map[string]any) (string, error) {
	target, _ := arguments["target"].(string)
	if strings.TrimSpace(target) == "" {
		return "", errors.New("target is required")
	}
	rawPaths, ok := arguments["paths"].([]any)
	if !ok {
		return "", errors.New("paths must be a list of session file relative paths")
	}
	layout := paths.SessionLayout{Files: paths.SessionFiles(filesDir)}
	relatives := make([]string, 0, len(rawPaths))
	expected := make([]inputFileExpectation, 0, len(rawPaths))
	for _, raw := range rawPaths {
		relative, ok := raw.(string)
		if !ok {
			return "", errors.New("paths must be a list of session file relative paths")
		}
		fullPath, normalized, err := sessionfiles.Resolve(layout, relative)
		if err != nil {
			return "", fmt.Errorf("session file %q: %w", relative, err)
		}
		info, err := os.Stat(fullPath)
		if err != nil {
			return "", fmt.Errorf("session file %q: %w", relative, err)
		}
		relatives = append(relatives, normalized)
		expected = append(expected, inputFileExpectation{Name: path.Base(normalized), Size: info.Size()})
	}

	selector := target
	if snapshotRefPattern.MatchString(target) {
		selector = "aria-ref=" + target
	}
	selectorJSON, err := json.Marshal(selector)
	if err != nil {
		return "", err
	}
	pathsJSON, err := json.Marshal(relatives)
	if err != nil {
		return "", err
	}
	expectedJSON, err := json.Marshal(expected)
	if err != nil {
		return "", err
	}
	targetJSON, err := json.Marshal(target)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(`async (page) => {
  const input = page.locator(%[1]s);
  if (await input.count() === 0) {
    throw new Error(%[4]s + ' does not match any elements. Capture a new snapshot if it is a reference.');
  }
  const expected = %[2]s;
  await input.setInputFiles(%[3]s);
  const actual = await input.evaluate((element) => Array.from(element.files ?? [], (file) => ({ name: file.name, size: file.size })));
  const readable = actual.length === expected.length && actual.every((file, index) => file.name === expected[index].name && file.size === expected[index].size);
  if (!readable) {
    await input.setInputFiles([]);
    throw new Error('The page cannot read the files it was given: the input reports ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + '. The input was cleared so the page does not use them. Open the page in a new tab and try again.');
  }
  return actual;
}`, selectorJSON, expectedJSON, pathsJSON, targetJSON), nil
}
