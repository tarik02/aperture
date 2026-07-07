package deploystate

import "testing"

func TestCandidateURLUsesInactiveColorFromState(t *testing.T) {
	state := State{
		ActiveColor: "blue",
		BlueURL:     "http://127.0.0.1:28080",
		GreenURL:    "http://127.0.0.1:28082",
	}

	candidateURL, err := CandidateURL(state)
	if err != nil {
		t.Fatalf("CandidateURL() error = %v", err)
	}
	if candidateURL != state.GreenURL {
		t.Fatalf("CandidateURL() = %q, want %q", candidateURL, state.GreenURL)
	}
}
