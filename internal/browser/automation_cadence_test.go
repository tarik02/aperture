package browser

import "testing"

func TestResolveAutomationCadence(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		recordings automationCadence
		watchable  bool
		want       automationCadence
	}{
		{cadenceImmediate, false, cadenceImmediate},
		{cadenceImmediate, true, cadenceFast},
		{cadenceInstant, false, cadenceInstant},
		{cadenceInstant, true, cadenceFast},
		{cadenceFast, false, cadenceFast},
		{cadenceSlow, false, cadenceSlow},
		{cadenceSlow, true, cadenceSlow},
	} {
		if got := resolveAutomationCadence(tc.recordings, tc.watchable); got != tc.want {
			t.Errorf("resolve(%v, %v) = %v, want %v", tc.recordings, tc.watchable, got, tc.want)
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
	if got := session.automationCadence(); got != cadenceFast {
		t.Fatalf("cadence after watchable = %v", got)
	}
	delete(session.clients, editor.id)
	if got := session.automationCadence(); got != cadenceImmediate {
		t.Fatalf("cadence after the editor left = %v", got)
	}
	session.recordingCadence.Store(int32(cadenceFast))
	if got := session.automationCadence(); got != cadenceFast {
		t.Fatalf("cadence while recording = %v", got)
	}
	if !isLiveSessionCommand("automation.pacing.set") {
		t.Fatal("pacing must be a reliable command")
	}
}
