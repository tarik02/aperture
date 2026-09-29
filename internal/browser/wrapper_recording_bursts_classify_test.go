package browser

import "testing"

func TestClassifyBurstAction(t *testing.T) {
	for _, test := range []struct {
		tool      string
		arguments map[string]any
		want      burstActionKind
	}{
		{"browser_click", nil, burstActionPointer},
		{"browser_scroll", nil, burstActionPointer},
		{"browser_navigate", map[string]any{"url": "https://example.com"}, burstActionChange},
		{"browser_evaluate", map[string]any{"function": "() => 1"}, burstActionChange},
		{"browser_tabs", map[string]any{"action": "list"}, burstActionNone},
		{"browser_tabs", map[string]any{"action": "new"}, burstActionChange},
		{"browser_tabs", map[string]any{"action": "select", "index": 1.0}, burstActionChange},
		{"browser_wait_for", map[string]any{"time": 2.0}, burstActionObserve},
		{"browser_wait_for", map[string]any{"text": "Done"}, burstActionChange},
		{"browser_wait_for", map[string]any{"textGone": "Loading"}, burstActionChange},
		{"browser_snapshot", nil, burstActionNone},
		{"browser_cookie_set", map[string]any{"name": "a"}, burstActionNone},
		// A tool nobody has classified is recorded: better a clip too many than a
		// missed effect.
		{"browser_new_tool", nil, burstActionChange},
	} {
		if got := classifyBurstAction(test.tool, test.arguments); got != test.want {
			t.Errorf("%s %v: %v, want %v", test.tool, test.arguments, got, test.want)
		}
	}
}
