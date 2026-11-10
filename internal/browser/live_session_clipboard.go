package browser

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/aperture/aperture/internal/paths"
	"github.com/aperture/aperture/internal/sessionfiles"
	remoteinput "github.com/tarik02/webdesktop/input"
	"golang.org/x/sys/unix"
)

// liveSessionSelectionWireLimit bounds the clipboard's JSON-encoded text in clipboard.state, since
// data channel messages may be limited to 64 KiB.
const liveSessionSelectionWireLimit = 28 * 1024

// liveSessionSelectionTypesLimit bounds its JSON-encoded MIME types for the same reason.
const (
	liveSessionSelectionTypesLimit      = 2 * 1024
	liveSessionSelectionMaximumTypes    = 16
	liveSessionClipboardConcurrentReads = 4
)

// liveSessionClipboardInlineLimit bounds JSON-encoded text sent inside one clipboard message,
// below the 64 KiB a data channel may allow. Larger or binary data moves through session files.
const liveSessionClipboardInlineLimit = 48 * 1024

// liveSessionClipboardMaxBytes bounds one clipboard transfer in either direction.
const liveSessionClipboardMaxBytes = 16 * 1024 * 1024

const (
	liveSessionClipboardMaxTypes   = 8
	liveSessionClipboardMaxTypeLen = 255
)

// liveSessionClipboardDirectory holds clipboard data in transit through session files. Clipboards
// carry passwords, so its files are deleted as soon as they are used and swept after
// liveSessionClipboardFileLifetime when a client never collects them.
const (
	liveSessionClipboardDirectory     = "clipboard"
	liveSessionClipboardFileLifetime  = time.Minute
	liveSessionClipboardSweepInterval = 15 * time.Second
)

const (
	liveSessionClipboardRetryDelay = time.Second
	// liveSessionClipboardRetryLimit caps the reconnect backoff of the selection watcher.
	liveSessionClipboardRetryLimit = 30 * time.Second
	// liveSessionClipboardTransferTimeout bounds waiting on the browser to produce or take data.
	liveSessionClipboardTransferTimeout = 10 * time.Second
)

// liveSessionClipboardCoalesceDelay gathers clipboard changes, such as a cut clearing and setting
// it, into one update.
const liveSessionClipboardCoalesceDelay = 100 * time.Millisecond

// liveSessionClipboard is the browser's clipboard: its text, if any, and the types its owner
// offers. Revision grows with every change the browser makes, so clients can tell a fresh
// copy of the same text from a repeat.
type liveSessionClipboard struct {
	Text      string   `json:"text"`
	Truncated bool     `json:"truncated,omitempty"`
	Types     []string `json:"types,omitempty"`
	// Pasted is set when a client's paste, not a program, put the data there.
	Pasted   bool   `json:"pasted,omitempty"`
	Revision uint64 `json:"revision"`
}

// liveSessionClipboardItem is one type of data a client pastes.
type liveSessionClipboardItem struct {
	mimeType string
	data     []byte
}

// liveSessionClipboardWriteItem is one type of a clipboard.write: its text, or a session file in
// the clipboard directory that holds its data.
type liveSessionClipboardWriteItem struct {
	MimeType     string  `json:"mimeType"`
	Text         *string `json:"text"`
	RelativePath string  `json:"relativePath"`
}

// applyHelloClipboard records that a client asked for clipboard state with its hello. Clients
// that omit it reject unknown messages, so they never receive it. Only the aperture compositor
// serves the clipboard, so other sessions never advertise it.
func (session *liveSession) applyHelloClipboard(client *liveSessionClient, enabled *bool) {
	if enabled == nil {
		return
	}
	supported := multiTargetCompositorEnabled(session.runtime.values)
	session.mu.Lock()
	client.clipboardAware = *enabled && supported
	session.mu.Unlock()
}

// receivesClipboard says whether a client is sent the clipboard; viewers only watch the session.
func (client *liveSessionClient) receivesClipboard() bool {
	return client.clipboardAware && client.role != "viewer"
}

// watchClipboard follows the compositor's selections until ctx ends, reconnecting if it drops.
func (session *liveSession) watchClipboard(ctx context.Context) {
	delay := liveSessionClipboardRetryDelay
	lastError := ""
	for {
		err := session.followCompositorSelections(ctx)
		if ctx.Err() != nil {
			return
		}
		// A shell without selection-watch would otherwise log this every second for the session.
		if message := err.Error(); message != lastError {
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: watch clipboard: %v\n", err)
			lastError = message
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, liveSessionClipboardRetryLimit)
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
		fields := strings.Fields(line)
		if len(fields) == 0 {
			return errors.New("selection watch line is empty")
		}
		switch fields[0] {
		case "selection":
			selection, err := parseCompositorSelection(fields)
			if err != nil {
				return err
			}
			session.updateSelection(selection)
		case "send":
			id, mimeType, err := parseCompositorSend(fields)
			if err != nil {
				return err
			}
			go session.providePastedData(ctx, id, mimeType)
		default:
			return fmt.Errorf("selection watch line is unknown: %q", strings.TrimSpace(line))
		}
	}
}

// parseCompositorSelection reads
// "selection <truncated> <hex text> <hex types> <pasted>", where hex is "-"
// when empty and types are newline-separated.
func parseCompositorSelection(fields []string) (liveSessionClipboard, error) {
	if len(fields) != 5 {
		return liveSessionClipboard{}, fmt.Errorf("selection line is invalid: %q", strings.Join(fields, " "))
	}
	var selection liveSessionClipboard
	switch fields[1] {
	case "0":
	case "1":
		selection.Truncated = true
	default:
		return liveSessionClipboard{}, fmt.Errorf("selection truncation flag is invalid: %q", fields[1])
	}
	text, err := decodeCompositorHex(fields[2])
	if err != nil {
		return liveSessionClipboard{}, errors.New("selection text is not hex")
	}
	types, err := decodeCompositorHex(fields[3])
	if err != nil {
		return liveSessionClipboard{}, errors.New("selection types are not hex")
	}
	if types != "" {
		selection.Types = limitSelectionTypes(strings.Split(types, "\n"))
	}
	switch fields[4] {
	case "0":
	case "1":
		selection.Pasted = true
	default:
		return liveSessionClipboard{}, fmt.Errorf("selection pasted flag is invalid: %q", fields[4])
	}
	var wireTruncated bool
	selection.Text, wireTruncated = limitSelectionText(text)
	selection.Truncated = selection.Truncated || wireTruncated
	return selection, nil
}

// parseCompositorSend reads "send <id> <hex type>": a program wants the data this wrapper pasted.
func parseCompositorSend(fields []string) (uint64, string, error) {
	if len(fields) != 3 {
		return 0, "", fmt.Errorf("send line is invalid: %q", strings.Join(fields, " "))
	}
	id, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("send id is invalid: %q", fields[1])
	}
	mimeType, err := decodeCompositorHex(fields[2])
	if err != nil || mimeType == "" {
		return 0, "", errors.New("send type is not hex")
	}
	return id, mimeType, nil
}

func decodeCompositorHex(field string) (string, error) {
	if field == "-" {
		return "", nil
	}
	raw, err := hex.DecodeString(field)
	return string(raw), err
}

// limitSelectionText keeps the longest valid UTF-8 prefix of text whose JSON encoding fits the
// wire limit. The compositor may have cut the text mid-character, which this also repairs.
func limitSelectionText(text string) (string, bool) {
	size := 0
	for index, r := range text {
		if r == utf8.RuneError {
			if _, length := utf8.DecodeRuneInString(text[index:]); length == 1 {
				return text[:index], true
			}
		}
		encoded := jsonRuneWireWidth(r)
		if size+encoded > liveSessionSelectionWireLimit {
			return text[:index], true
		}
		size += encoded
	}
	return text, false
}

// limitSelectionTypes keeps the offered types that fit beside the clipboard's text, so an
// owner offering a pathological list cannot push clipboard.state past a data channel limit.
func limitSelectionTypes(types []string) []string {
	kept := make([]string, 0, min(len(types), liveSessionSelectionMaximumTypes))
	size := 0
	for _, mimeType := range types {
		if len(kept) == liveSessionSelectionMaximumTypes {
			break
		}
		if !validClipboardType(mimeType) {
			continue
		}
		encoded := 2 // quotes
		for _, r := range mimeType {
			encoded += jsonRuneWireWidth(r)
		}
		if size+encoded+1 > liveSessionSelectionTypesLimit { // the separating comma
			break
		}
		size += encoded + 1
		kept = append(kept, mimeType)
	}
	return kept
}

// jsonRuneWireWidth is the length of r once encoding/json has escaped it.
func jsonRuneWireWidth(r rune) int {
	switch {
	case r == '"' || r == '\\' || r == '\n' || r == '\r' || r == '\t':
		return 2
	case r < 0x20 || r == '<' || r == '>' || r == '&' || r == '\u2028' || r == '\u2029':
		return 6
	}
	return utf8.RuneLen(r)
}

func (session *liveSession) updateSelection(next liveSessionClipboard) {
	session.mu.Lock()
	next.Revision = session.clipboard.Revision + 1
	session.clipboard = next
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

// readClipboard answers clipboard.read with the data as text when it fits one message, and
// otherwise, for clients that asked, as a session file the client downloads and deletes.
func (session *liveSession) readClipboard(client *liveSessionClient, message liveSessionClientMessage) (liveSessionServerMessage, error) {
	if err := requireBrowserMutation(client); err != nil {
		return liveSessionServerMessage{}, err
	}
	if !validClipboardType(message.MimeType) {
		return liveSessionServerMessage{}, errors.New("clipboard type is invalid")
	}
	select {
	case session.clipboardReadSlots <- struct{}{}:
		defer func() { <-session.clipboardReadSlots }()
	default:
		return liveSessionServerMessage{}, errors.New("clipboard is busy")
	}
	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionClipboardTransferTimeout)
	defer cancel()
	command := "selection-read " + hex.EncodeToString([]byte(message.MimeType)) + "\n"
	pipe, err := compositorControlFile(ctx, session.runtime.controlSocket, command)
	if err != nil {
		return liveSessionServerMessage{}, err
	}
	defer func() { _ = pipe.Close() }()
	if deadline, ok := ctx.Deadline(); ok {
		_ = pipe.SetReadDeadline(deadline)
	}
	data, err := io.ReadAll(io.LimitReader(pipe, liveSessionClipboardMaxBytes+1))
	if err != nil {
		return liveSessionServerMessage{}, fmt.Errorf("read clipboard: %w", err)
	}
	if len(data) > liveSessionClipboardMaxBytes {
		return liveSessionServerMessage{}, errors.New("clipboard data is too large")
	}
	result := liveSessionServerMessage{MimeType: message.MimeType}
	if fitsInlineClipboardText(data) {
		text := string(data)
		result.Text = &text
		return result, nil
	}
	if !message.Files {
		return liveSessionServerMessage{}, errors.New("clipboard data does not fit a message")
	}
	result.RelativePath, err = session.storeClipboardFile(data)
	if err != nil {
		return liveSessionServerMessage{}, fmt.Errorf("store clipboard data: %w", err)
	}
	return result, nil
}

// fitsInlineClipboardText reports whether data is text that fits one clipboard message.
func fitsInlineClipboardText(data []byte) bool {
	if len(data) > liveSessionClipboardInlineLimit || !utf8.Valid(data) {
		return false
	}
	size := 0
	for _, r := range string(data) {
		size += jsonRuneWireWidth(r)
		if size > liveSessionClipboardInlineLimit {
			return false
		}
	}
	return true
}

func (session *liveSession) clipboardFilesDir() string {
	return filepath.Join(session.runtime.values.FilesDir, liveSessionClipboardDirectory)
}

// storeClipboardFile writes copied data to a new file in the clipboard directory, within the
// session's storage limits, and returns its relative path.
func (session *liveSession) storeClipboardFile(data []byte) (string, error) {
	values := session.runtime.values
	quota := values.SessionStorageQuotaBytes
	if quota <= 0 {
		quota = defaultSessionStorageQuotaBytes
	}
	footprint, err := sessionfiles.Footprint(values.UpperDir, values.FilesDir, values.CacheDir)
	if err != nil {
		return "", err
	}
	if footprint+int64(len(data)) > quota {
		return "", errors.New("session storage quota exceeded")
	}
	// The directory and the file.
	if err := sessionfiles.CheckEntryBudget(values.FilesDir, 2); err != nil {
		return "", err
	}
	dir := session.clipboardFilesDir()
	if err := ensureRegularDirectory(dir); err != nil {
		return "", err
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return "", err
	}
	name := "copy-" + hex.EncodeToString(suffix)
	full := filepath.Join(dir, name)
	file, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return "", err
	}
	_, err = file.Write(data)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(full)
		return "", err
	}
	return liveSessionClipboardDirectory + "/" + name, nil
}

// sweepClipboardFiles deletes clipboard files a client left behind until ctx ends.
func (session *liveSession) sweepClipboardFiles(ctx context.Context) {
	ticker := time.NewTicker(liveSessionClipboardSweepInterval)
	defer ticker.Stop()
	for {
		if err := removeStaleClipboardFiles(session.clipboardFilesDir(), time.Now().Add(-liveSessionClipboardFileLifetime)); err != nil {
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: sweep clipboard files: %v\n", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func removeStaleClipboardFiles(dir string, cutoff time.Time) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

// requireClipboardInputLease reports whether the client holds the input lease. A paste replaces
// the shared browser's clipboard, so it follows ADR 0003 like other browser input.
func (session *liveSession) requireClipboardInputLease(client *liveSessionClient) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.holder != client {
		return remoteinput.ErrNotOwner
	}
	return nil
}

// commitClipboardWrite makes a client's paste the browser's clipboard. The session files it
// names are deleted whether or not the paste succeeds.
func (session *liveSession) commitClipboardWrite(client *liveSessionClient, message liveSessionClientMessage) (liveSessionServerMessage, error) {
	defer session.removeClipboardWriteFiles(message.Items)
	if err := requireBrowserMutation(client); err != nil {
		return liveSessionServerMessage{}, err
	}
	if err := session.requireClipboardInputLease(client); err != nil {
		return liveSessionServerMessage{}, err
	}
	written, err := session.clipboardWriteItems(message.Items)
	if err != nil {
		return liveSessionServerMessage{}, err
	}
	items := offeredClipboardItems(written)
	types := make([]string, 0, len(items))
	for _, item := range items {
		types = append(types, item.mimeType)
	}
	session.clipboardWriteMu.Lock()
	defer session.clipboardWriteMu.Unlock()
	session.mu.Lock()
	previous := session.pasted
	session.pasted = items
	session.mu.Unlock()
	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionClipboardTransferTimeout)
	defer cancel()
	command := "selection-set clipboard " + hex.EncodeToString([]byte(strings.Join(types, "\n"))) + "\n"
	if _, err := sendCompositorControlCommand(ctx, session.runtime.controlSocket, command); err != nil {
		// The browser still holds the previous clipboard, so requests for it must keep working.
		session.mu.Lock()
		session.pasted = previous
		session.mu.Unlock()
		return liveSessionServerMessage{}, err
	}
	return liveSessionServerMessage{}, nil
}

// clipboardWriteItems collects the data of a clipboard.write, one entry per type.
func (session *liveSession) clipboardWriteItems(requested []liveSessionClipboardWriteItem) ([]liveSessionClipboardItem, error) {
	if len(requested) == 0 {
		return nil, errors.New("clipboard write has no data")
	}
	if len(requested) > liveSessionClipboardMaxTypes {
		return nil, errors.New("clipboard has too many types")
	}
	items := make([]liveSessionClipboardItem, 0, len(requested))
	size := 0
	for _, item := range requested {
		if !validClipboardType(item.MimeType) {
			return nil, errors.New("clipboard type is invalid")
		}
		for _, existing := range items {
			if existing.mimeType == item.MimeType {
				return nil, errors.New("clipboard type is repeated")
			}
		}
		var data []byte
		switch {
		case item.Text != nil && item.RelativePath == "":
			data = []byte(*item.Text)
		case item.Text == nil && item.RelativePath != "":
			read, err := session.readClipboardWriteFile(item.RelativePath, liveSessionClipboardMaxBytes-size)
			if err != nil {
				return nil, err
			}
			data = read
		default:
			return nil, errors.New("clipboard item needs either text or a relative path")
		}
		size += len(data)
		if size > liveSessionClipboardMaxBytes {
			return nil, errors.New("clipboard data is too large")
		}
		items = append(items, liveSessionClipboardItem{mimeType: item.MimeType, data: data})
	}
	return items, nil
}

// clipboardWriteFile resolves a pasted file, which must be in the clipboard directory so a paste
// cannot consume any other session file.
func (session *liveSession) clipboardWriteFile(relative string) (string, error) {
	layout := paths.SessionLayout{Files: paths.SessionFiles(session.runtime.values.FilesDir)}
	full, normalized, err := sessionfiles.Resolve(layout, relative)
	if err != nil {
		return "", fmt.Errorf("clipboard file %q: %w", relative, err)
	}
	if path.Dir(normalized) != liveSessionClipboardDirectory {
		return "", fmt.Errorf("clipboard file %q is not in %s/", relative, liveSessionClipboardDirectory)
	}
	return full, nil
}

func (session *liveSession) readClipboardWriteFile(relative string, limit int) ([]byte, error) {
	full, err := session.clipboardWriteFile(relative)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(full, os.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, errors.New("clipboard data is too large")
	}
	return data, nil
}

func (session *liveSession) removeClipboardWriteFiles(items []liveSessionClipboardWriteItem) {
	for _, item := range items {
		if item.RelativePath == "" {
			continue
		}
		full, err := session.clipboardWriteFile(item.RelativePath)
		if err != nil {
			continue
		}
		if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "browser-session-wrapper: remove clipboard file: %v\n", err)
		}
	}
}

// offeredClipboardItems adds the names Wayland programs ask plain text by, which Chromium
// prefers over text/plain.
func offeredClipboardItems(items []liveSessionClipboardItem) []liveSessionClipboardItem {
	offered := make([]liveSessionClipboardItem, 0, len(items)+2)
	for _, item := range items {
		if item.mimeType == "text/plain" {
			offered = append(offered,
				liveSessionClipboardItem{mimeType: "text/plain;charset=utf-8", data: item.data},
				liveSessionClipboardItem{mimeType: "UTF8_STRING", data: item.data},
			)
		}
		offered = append(offered, item)
	}
	return offered
}

// providePastedData writes what this wrapper pasted into the pipe of the program asking for it.
func (session *liveSession) providePastedData(ctx context.Context, id uint64, mimeType string) {
	session.mu.Lock()
	var data []byte
	found := false
	for _, item := range session.pasted {
		if item.mimeType == mimeType {
			data, found = item.data, true
			break
		}
	}
	session.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, liveSessionClipboardTransferTimeout)
	defer cancel()
	pipe, err := compositorControlFile(ctx, session.runtime.controlSocket, fmt.Sprintf("selection-take %d\n", id))
	if err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: provide clipboard: %v\n", err)
		return
	}
	defer func() { _ = pipe.Close() }()
	if !found {
		return
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = pipe.SetWriteDeadline(deadline)
	}
	if _, err := io.Copy(pipe, bytes.NewReader(data)); err != nil {
		fmt.Fprintf(os.Stderr, "browser-session-wrapper: provide clipboard: %v\n", err)
	}
}

func validClipboardType(mimeType string) bool {
	if mimeType == "" || len(mimeType) > liveSessionClipboardMaxTypeLen {
		return false
	}
	for _, r := range mimeType {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// compositorControlFile sends a control command whose answer carries a pipe, and returns it
// non-blocking so reads and writes honor deadlines.
func compositorControlFile(ctx context.Context, socketPath string, command string) (*os.File, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("dial compositor control socket: %w", err)
	}
	defer func() { _ = conn.Close() }()
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, errors.New("compositor control socket is not a unix socket")
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = unixConn.SetDeadline(deadline)
	}
	if _, err := unixConn.Write([]byte(command)); err != nil {
		return nil, fmt.Errorf("send compositor control command: %w", err)
	}
	response := make([]byte, 512)
	oob := make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := unixConn.ReadMsgUnix(response, oob)
	if err != nil {
		return nil, fmt.Errorf("read compositor control response: %w", err)
	}
	var fds []int
	if messages, err := syscall.ParseSocketControlMessage(oob[:oobn]); err == nil {
		for _, message := range messages {
			if rights, err := syscall.ParseUnixRights(&message); err == nil {
				fds = append(fds, rights...)
			}
		}
	}
	answer := strings.TrimSpace(string(response[:n]))
	if answer != "ok" || len(fds) != 1 {
		for _, fd := range fds {
			_ = syscall.Close(fd)
		}
		if answer == "ok" {
			return nil, errors.New("compositor control answer carried no pipe")
		}
		return nil, fmt.Errorf("compositor control rejected: %s", answer)
	}
	if err := syscall.SetNonblock(fds[0], true); err != nil {
		_ = syscall.Close(fds[0])
		return nil, err
	}
	return os.NewFile(uintptr(fds[0]), "clipboard"), nil
}
