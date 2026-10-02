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

func TestAutomationCadenceStateFollowsPacingAndRecordings(t *testing.T) {
	t.Parallel()
	state := newAutomationCadenceState()
	if got := state.current(); got != cadenceImmediate {
		t.Fatalf("empty state = %v", got)
	}
	state.setPacing("a", automationPacingWatchable)
	state.setPacing("b", automationPacingWatchable)
	state.clearPacing("a")
	if got := state.current(); got != cadenceRecorded {
		t.Fatalf("one watchable client left = %v", got)
	}
	state.setPacing("b", automationPacingNormal)
	var active, presentation bool
	state.setRecordingSource(func() (bool, bool) { return active, presentation })
	if got := state.current(); got != cadenceImmediate {
		t.Fatalf("no watchers or recordings = %v", got)
	}
	active = true
	if got := state.current(); got != cadenceRecorded {
		t.Fatalf("recording = %v", got)
	}
	presentation = true
	if got := state.current(); got != cadencePresentation {
		t.Fatalf("presentation recording = %v", got)
	}
}

func TestAutomationPacingCommandIsLimitedToEditorsAndEndsWithTheClient(t *testing.T) {
	t.Parallel()
	session := &liveSession{
		runtime: newWrapperRuntime(RuntimeEnvValues{}, ""),
		clients: make(map[string]*liveSessionClient),
	}
	set := func(client *liveSessionClient, pacing string) error {
		_, err := session.handleSessionCommand(client, liveSessionClientMessage{Type: "presentation.automation.set", Pacing: pacing})
		return err
	}
	if err := set(&liveSessionClient{id: "viewer", role: "viewer"}, "watchable"); err == nil {
		t.Fatal("viewers must not set pacing")
	}
	editor := &liveSessionClient{id: "editor", role: "editor"}
	if err := set(editor, "fast"); err == nil {
		t.Fatal("unknown pacing was accepted")
	}
	if err := set(editor, "watchable"); err != nil {
		t.Fatal(err)
	}
	if got := session.runtime.cadence.current(); got != cadenceRecorded {
		t.Fatalf("cadence after watchable = %v", got)
	}
	if err := set(editor, "normal"); err != nil {
		t.Fatal(err)
	}
	if got := session.runtime.cadence.current(); got != cadenceImmediate {
		t.Fatalf("cadence after normal = %v", got)
	}
	if !isLiveSessionCommand("presentation.automation.set") {
		t.Fatal("pacing must be a reliable command")
	}
}
