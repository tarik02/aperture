package browser

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// liveSessionSelectionWireLimit bounds one selection's JSON-encoded text. Data channel messages
// may be limited to 64 KiB, and a clipboard.state carries both selections.
const liveSessionSelectionWireLimit = 28 * 1024

const liveSessionClipboardRetryDelay = time.Second

// liveSessionClipboardCoalesceDelay gathers selection changes into one update. Chromium clears and
// sets the primary selection on every step of a selection drag.
const liveSessionClipboardCoalesceDelay = 100 * time.Millisecond

// liveSessionSelection is the text of one of the browser's selections. Revision grows with every
// change the browser makes, so clients can tell a fresh copy of the same text from a repeat.
type liveSessionSelection struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
	Revision  uint64 `json:"revision"`
}

// liveSessionClipboard is the browser's clipboard and its primary selection (the text last selected).
type liveSessionClipboard struct {
	Clipboard liveSessionSelection `json:"clipboard"`
	Primary   liveSessionSelection `json:"primary"`
}

// applyHelloClipboard records that a client asked for clipboard state with its hello. Clients
// that omit it reject unknown messages, so they never receive it.
func (session *liveSession) applyHelloClipboard(client *liveSessionClient, enabled *bool) {
	if enabled == nil || !*enabled {
		return
	}
	session.mu.Lock()
	client.clipboardAware = true
	session.mu.Unlock()
}

// receivesClipboard says whether a client is sent the clipboard; viewers only watch the session.
func (client *liveSessionClient) receivesClipboard() bool {
	return client.clipboardAware && client.role != "viewer"
}

// watchClipboard follows the compositor's selections until ctx ends, reconnecting if it drops.
func (session *liveSession) watchClipboard(ctx context.Context) {
	for {
		err := session.followCompositorSelections(ctx)
		if ctx.Err() != nil {
			return
		}
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: watch clipboard: %v\n", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(liveSessionClipboardRetryDelay):
		}
	}
}

func (session *liveSession) followCompositorSelections(ctx context.Context) error {
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", session.runtime.controlSocket)
	if err != nil {
		return fmt.Errorf("dial compositor control socket: %w", err)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	defer func() { _ = conn.Close() }()

	if _, err := conn.Write([]byte("selection-watch\n")); err != nil {
		return fmt.Errorf("send selection-watch: %w", err)
	}
	reader := bufio.NewReader(conn)
	response, err := reader.ReadString('\n')
	if err != nil {
		return fmt.Errorf("read selection-watch response: %w", err)
	}
	if strings.TrimSpace(response) != "ok" {
		return fmt.Errorf("compositor control rejected selection-watch: %s", strings.TrimSpace(response))
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("read selection: %w", err)
		}
		kind, text, truncated, err := parseCompositorSelection(line)
		if err != nil {
			return err
		}
		session.updateSelection(kind, text, truncated)
	}
}

// parseCompositorSelection reads "selection <clipboard|primary> <truncated> <hex text or ->".
func parseCompositorSelection(line string) (kind string, text string, truncated bool, err error) {
	fields := strings.Fields(line)
	if len(fields) != 4 || fields[0] != "selection" {
		return "", "", false, fmt.Errorf("selection line is invalid: %q", strings.TrimSpace(line))
	}
	kind = fields[1]
	if kind != "clipboard" && kind != "primary" {
		return "", "", false, fmt.Errorf("selection kind is unknown: %q", kind)
	}
	switch fields[2] {
	case "0":
	case "1":
		truncated = true
	default:
		return "", "", false, fmt.Errorf("selection truncation flag is invalid: %q", fields[2])
	}
	if fields[3] != "-" {
		raw, err := hex.DecodeString(fields[3])
		if err != nil {
			return "", "", false, errors.New("selection text is not hex")
		}
		text = string(raw)
	}
	text, wireTruncated := limitSelectionText(text)
	return kind, text, truncated || wireTruncated, nil
}

// limitSelectionText keeps the longest valid UTF-8 prefix of text whose JSON encoding fits the
// wire limit. The compositor may have cut the text mid-character, which this also repairs.
func limitSelectionText(text string) (string, bool) {
	size := 0
	for index, r := range text {
		width := utf8.RuneLen(r)
		if r == utf8.RuneError {
			if _, length := utf8.DecodeRuneInString(text[index:]); length == 1 {
				return text[:index], true
			}
		}
		encoded := width
		switch {
		case r == '"' || r == '\\' || r == '\n' || r == '\r' || r == '\t':
			encoded = 2
		case r < 0x20 || r == '<' || r == '>' || r == '&' || r == '\u2028' || r == '\u2029':
			encoded = 6
		}
		if size+encoded > liveSessionSelectionWireLimit {
			return text[:index], true
		}
		size += encoded
	}
	return text, false
}

func (session *liveSession) updateSelection(kind, text string, truncated bool) {
	session.mu.Lock()
	selection := &session.clipboard.Clipboard
	if kind == "primary" {
		selection = &session.clipboard.Primary
	}
	selection.Text = text
	selection.Truncated = truncated
	selection.Revision++
	if session.clipboardBroadcast == nil {
		session.clipboardBroadcast = time.AfterFunc(liveSessionClipboardCoalesceDelay, session.broadcastClipboard)
	}
	session.mu.Unlock()
}

func (session *liveSession) broadcastClipboard() {
	session.mu.Lock()
	session.clipboardBroadcast = nil
	state := session.clipboard
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		if client.receivesClipboard() {
			clients = append(clients, client)
		}
	}
	session.mu.Unlock()
	message := liveSessionServerMessage{Type: "clipboard.state", Clipboard: &state}
	for _, client := range clients {
		client.queueStateUpdate(message)
	}
}
