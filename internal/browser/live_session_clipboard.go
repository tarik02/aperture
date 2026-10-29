package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

// liveSessionSelectionWireLimit bounds one selection's JSON-encoded text. Data channel messages
// may be limited to 64 KiB, and a clipboard.state carries both selections.
const liveSessionSelectionWireLimit = 28 * 1024

// liveSessionClipboardChunkSize is the payload of one clipboard data message; base64 and the
// envelope keep it under a 64 KiB data channel message.
const liveSessionClipboardChunkSize = 32 * 1024

// liveSessionClipboardMaxBytes bounds one clipboard transfer in either direction.
const liveSessionClipboardMaxBytes = 16 * 1024 * 1024

const (
	liveSessionClipboardMaxTypes   = 8
	liveSessionClipboardMaxTypeLen = 255
)

const (
	liveSessionClipboardRetryDelay = time.Second
	// liveSessionClipboardTransferTimeout bounds waiting on the browser to produce or take data.
	liveSessionClipboardTransferTimeout = 10 * time.Second
)

// liveSessionClipboardCoalesceDelay gathers selection changes into one update. Chromium clears and
// sets the primary selection on every step of a selection drag.
const liveSessionClipboardCoalesceDelay = 100 * time.Millisecond

// liveSessionSelection is one of the browser's selections: its text, if any, and the types its
// owner offers. Revision grows with every change the browser makes, so clients can tell a fresh
// copy of the same text from a repeat.
type liveSessionSelection struct {
	Text      string   `json:"text"`
	Truncated bool     `json:"truncated,omitempty"`
	Types     []string `json:"types,omitempty"`
	Revision  uint64   `json:"revision"`
}

// liveSessionClipboard is the browser's clipboard and its primary selection (the text last selected).
type liveSessionClipboard struct {
	Clipboard liveSessionSelection `json:"clipboard"`
	Primary   liveSessionSelection `json:"primary"`
}

// liveSessionClipboardItem is one type of data a client pastes.
type liveSessionClipboardItem struct {
	mimeType string
	data     []byte
}

// liveSessionClipboardWrite collects a client's paste until it commits it.
type liveSessionClipboardWrite struct {
	requestID string
	items     []liveSessionClipboardItem
	size      int
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
		fields := strings.Fields(line)
		if len(fields) == 0 {
			return errors.New("selection watch line is empty")
		}
		switch fields[0] {
		case "selection":
			kind, selection, err := parseCompositorSelection(fields)
			if err != nil {
				return err
			}
			session.updateSelection(kind, selection)
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

// parseCompositorSelection reads "selection <clipboard|primary> <truncated> <hex text> <hex types>",
// where hex is "-" when empty and types are newline-separated.
func parseCompositorSelection(fields []string) (string, liveSessionSelection, error) {
	if len(fields) != 5 {
		return "", liveSessionSelection{}, fmt.Errorf("selection line is invalid: %q", strings.Join(fields, " "))
	}
	kind := fields[1]
	if kind != "clipboard" && kind != "primary" {
		return "", liveSessionSelection{}, fmt.Errorf("selection kind is unknown: %q", kind)
	}
	var selection liveSessionSelection
	switch fields[2] {
	case "0":
	case "1":
		selection.Truncated = true
	default:
		return "", liveSessionSelection{}, fmt.Errorf("selection truncation flag is invalid: %q", fields[2])
	}
	text, err := decodeCompositorHex(fields[3])
	if err != nil {
		return "", liveSessionSelection{}, errors.New("selection text is not hex")
	}
	types, err := decodeCompositorHex(fields[4])
	if err != nil {
		return "", liveSessionSelection{}, errors.New("selection types are not hex")
	}
	if types != "" {
		selection.Types = strings.Split(types, "\n")
	}
	var wireTruncated bool
	selection.Text, wireTruncated = limitSelectionText(text)
	selection.Truncated = selection.Truncated || wireTruncated
	return kind, selection, nil
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

func (session *liveSession) updateSelection(kind string, next liveSessionSelection) {
	session.mu.Lock()
	selection := &session.clipboard.Clipboard
	if kind == "primary" {
		selection = &session.clipboard.Primary
	}
	next.Revision = selection.Revision + 1
	*selection = next
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

// readClipboard answers clipboard.read with the data in chunks ahead of the result.
func (session *liveSession) readClipboard(client *liveSessionClient, message liveSessionClientMessage) (liveSessionServerMessage, error) {
	if err := requireBrowserMutation(client); err != nil {
		return liveSessionServerMessage{}, err
	}
	if message.Selection != "clipboard" && message.Selection != "primary" {
		return liveSessionServerMessage{}, errors.New("clipboard selection is invalid")
	}
	if !validClipboardType(message.MimeType) {
		return liveSessionServerMessage{}, errors.New("clipboard type is invalid")
	}
	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionClipboardTransferTimeout)
	defer cancel()
	command := fmt.Sprintf("selection-read %s %s\n", message.Selection, hex.EncodeToString([]byte(message.MimeType)))
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
	for offset := 0; offset < len(data); offset += liveSessionClipboardChunkSize {
		end := min(offset+liveSessionClipboardChunkSize, len(data))
		result.chunks = append(result.chunks, liveSessionServerMessage{
			Type:      "clipboard.chunk",
			RequestID: message.RequestID,
			Data:      base64.StdEncoding.EncodeToString(data[offset:end]),
		})
	}
	return result, nil
}

// appendClipboardWrite adds one chunk of a paste. A chunk for another request starts over.
func (session *liveSession) appendClipboardWrite(client *liveSessionClient, message liveSessionClientMessage) error {
	if err := requireBrowserMutation(client); err != nil {
		return err
	}
	if !validLiveSessionRequestID(message.RequestID) {
		return errors.New("clipboard write requires a valid request ID")
	}
	if !validClipboardType(message.MimeType) {
		return errors.New("clipboard type is invalid")
	}
	data, err := base64.StdEncoding.DecodeString(message.Data)
	if err != nil {
		return errors.New("clipboard data is not base64")
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	write := client.clipboardWrite
	if write == nil || write.requestID != message.RequestID {
		write = &liveSessionClipboardWrite{requestID: message.RequestID}
		client.clipboardWrite = write
	}
	if write.size+len(data) > liveSessionClipboardMaxBytes {
		client.clipboardWrite = nil
		return errors.New("clipboard data is too large")
	}
	write.size += len(data)
	for index := range write.items {
		if write.items[index].mimeType == message.MimeType {
			write.items[index].data = append(write.items[index].data, data...)
			return nil
		}
	}
	if len(write.items) == liveSessionClipboardMaxTypes {
		client.clipboardWrite = nil
		return errors.New("clipboard has too many types")
	}
	write.items = append(write.items, liveSessionClipboardItem{mimeType: message.MimeType, data: data})
	return nil
}

// commitClipboardWrite makes a client's collected paste the browser's clipboard.
func (session *liveSession) commitClipboardWrite(client *liveSessionClient, message liveSessionClientMessage) (liveSessionServerMessage, error) {
	if err := requireBrowserMutation(client); err != nil {
		return liveSessionServerMessage{}, err
	}
	session.mu.Lock()
	write := client.clipboardWrite
	client.clipboardWrite = nil
	session.mu.Unlock()
	if write == nil || write.requestID != message.RequestID || len(write.items) == 0 {
		return liveSessionServerMessage{}, errors.New("clipboard write has no data")
	}
	items := offeredClipboardItems(write.items)
	types := make([]string, 0, len(items))
	for _, item := range items {
		types = append(types, item.mimeType)
	}
	session.clipboardWriteMu.Lock()
	defer session.clipboardWriteMu.Unlock()
	session.mu.Lock()
	session.pasted = items
	session.mu.Unlock()
	ctx, cancel := context.WithTimeout(session.runtime.ctx, liveSessionClipboardTransferTimeout)
	defer cancel()
	command := "selection-set clipboard " + hex.EncodeToString([]byte(strings.Join(types, "\n"))) + "\n"
	if _, err := sendCompositorControlCommand(ctx, session.runtime.controlSocket, command); err != nil {
		return liveSessionServerMessage{}, err
	}
	return liveSessionServerMessage{}, nil
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
