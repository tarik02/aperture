package browser

import "testing"

func TestResolveAutomationCadence(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		recording, presentation, watchable bool
		want                               automationCadence
	}{
		{false, false, false, cadenceImmediate},
		{false, false, true, cadenceRecorded},
		{true, false, false, cadenceRecorded},
		{true, true, false, cadencePresentation},
		{true, true, true, cadencePresentation},
	} {
		if got := resolveAutomationCadence(tc.recording, tc.presentation, tc.watchable); got != tc.want {
			t.Errorf("resolve(%v, %v, %v) = %v, want %v", tc.recording, tc.presentation, tc.watchable, got, tc.want)
		}
	}
}

func TestAutomationPacingCommandIsLimitedToEditorsAndEndsWithTheClient(t *testing.T) {
	t.Parallel()
	session := &liveSession{
		runtime: newWrapperRuntime(RuntimeEnvValues{}, ""),
		clients: make(map[string]*liveSessionClient),
	}
	set := func(client *liveSessionClient, pacing string) error {
		_, err := session.handleSessionCommand(client, liveSessionClientMessage{Type: "automation.pacing.set", Pacing: pacing})
		return err
	}
	if err := set(&liveSessionClient{id: "viewer", role: "viewer"}, "watchable"); err == nil {
		t.Fatal("viewers must not set pacing")
	}
	editor := &liveSessionClient{id: "editor", role: "editor"}
	session.clients[editor.id] = editor
	if err := set(editor, "fast"); err == nil {
		t.Fatal("unknown pacing was accepted")
	}
	if got := session.automationCadence(); got != cadenceImmediate {
		t.Fatalf("idle cadence = %v", got)
	}
	if err := set(editor, "watchable"); err != nil {
		t.Fatal(err)
	}
	if got := session.automationCadence(); got != cadenceRecorded {
		t.Fatalf("cadence after watchable = %v", got)
	}
	delete(session.clients, editor.id)
	if got := session.automationCadence(); got != cadenceImmediate {
		t.Fatalf("cadence after the editor left = %v", got)
	}
	session.activeRecordings.Store(1)
	if got := session.automationCadence(); got != cadenceRecorded {
		t.Fatalf("cadence while recording = %v", got)
	}
	if !isLiveSessionCommand("automation.pacing.set") {
		t.Fatal("pacing must be a reliable command")
	}
}
