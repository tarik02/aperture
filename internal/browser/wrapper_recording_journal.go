package browser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A recording's journal is a JSONL file in its private work dir, written only while the recording
// runs and only for this session's automation. Every entry has a kind and wall-clock times:
//
//	call       tool, ok                         an MCP browser tool call that is not read-only
//	glide      targetId, from, to               pointer travel in surface px (the path between is eased)
//	press      targetId, x, y, button, count, element
//	wheel      targetId, x, y, dx, dy
//	reveal     targetId                         smooth scroll that brought an element into view
//	caption    text                             recording.caption
//	focus      targetId, rect, zoom             recording.focus
//	attention  targetId, x, y, radius, loops    recording.attention
//
// and startMs and endMs, both Unix milliseconds. Surface px are CSS px of the target's viewport.
//
// The kind target, which automation reports as it starts to act on a tab, is not written: it only
// makes a bursts recording follow that tab.
type recordingJournal struct {
	path string

	mu      sync.Mutex
	size    int
	dropped int
}

func newRecordingJournal(segmentDir string) *recordingJournal {
	return &recordingJournal{path: filepath.Join(segmentDir, recordingJournalFile)}
}

// append adds a line unless the journal is over budget, which only a runaway recording reaches.
func (j *recordingJournal) append(line []byte) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.size+len(line) > recordingJournalBudget {
		j.dropped++
		return
	}
	file, err := os.OpenFile(j.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		j.dropped++
		return
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(line); err != nil {
		j.dropped++
		return
	}
	j.size += len(line)
}

// droppedEntries counts the entries the budget or a write failure lost.
func (j *recordingJournal) droppedEntries() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.dropped
}

func journalLine(kind string, started time.Time, fields map[string]any) []byte {
	fields["kind"], fields["startMs"], fields["endMs"] = kind, started.UnixMilli(), time.Now().UnixMilli()
	line, _ := json.Marshal(fields)
	return append(line, '\n')
}

// journalFunc adds an entry to every running recording; a nil one drops it.
type journalFunc func(kind string, started time.Time, fields map[string]any)

func (journal journalFunc) add(kind string, started time.Time, fields map[string]any) {
	if journal != nil {
		journal(kind, started, fields)
	}
}

// journal adds an entry that ended now to every running recording; a recording that is stopping
// or has failed no longer takes part.
func (session *liveSession) journal(kind string, started time.Time, fields map[string]any) {
	if session.activeRecordings.Load() == 0 {
		return
	}
	r := session.runtime
	r.mu.Lock()
	journals := make([]*recordingJournal, 0, len(session.recordings))
	targetID, _ := fields["targetId"].(string)
	for _, recording := range session.recordings {
		if recording.Status == wrapperRecordingRunning && !recording.stopping {
			journals = append(journals, recording.journal)
			if recording.follow != nil && targetID != "" && targetID != recording.TargetID {
				select { // the latest target wins
				case <-recording.follow:
				default:
				}
				recording.follow <- targetID // this is the only sender, under the lock, so there is room
			}
		}
	}
	r.mu.Unlock()
	if len(journals) == 0 || kind == "target" {
		return
	}
	line := journalLine(kind, started, fields)
	for _, journal := range journals {
		journal.append(line)
	}
}

// followAutomation moves a bursts recording to the tab the latest automation acted on, one move at
// a time. A move that fails (the tab is not ready yet) is retried by the next action's entry. The
// move starts after the action does, so the recording loses roughly the first 350 ms of an action on a new tab.
func (session *liveSession) followAutomation(ctx context.Context, recording *wrapperRecording) {
	for {
		select {
		case <-ctx.Done():
			return
		case targetID := <-recording.follow:
			_, _ = session.retargetRecording(ctx, recording.ID, targetID)
		}
	}
}
