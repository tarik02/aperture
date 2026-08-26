package browser

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/fsnotify/fsnotify"
)

func (r *wrapperRuntime) authorizeAutomationLease(req *http.Request) bool {
	provided, ok := strings.CutPrefix(strings.TrimSpace(req.Header.Get("Authorization")), "Bearer ")
	if !ok || provided == "" {
		return false
	}
	expected := strings.TrimSpace(r.values.SessionToken)
	if r.values.SessionTokenPath != "" {
		body, err := os.ReadFile(r.values.SessionTokenPath)
		if err != nil {
			return false
		}
		expected = strings.TrimSpace(string(body))
	}
	return expected != "" && subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func (r *wrapperRuntime) watchSessionToken(ctx context.Context) error {
	if r.values.SessionTokenPath == "" {
		return nil
	}
	current, err := os.ReadFile(r.values.SessionTokenPath)
	if err != nil {
		return fmt.Errorf("read session token: %w", err)
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("watch session token: %w", err)
	}
	if err := watcher.Add(filepath.Dir(r.values.SessionTokenPath)); err != nil {
		_ = watcher.Close()
		return fmt.Errorf("watch session token directory: %w", err)
	}
	currentToken := strings.TrimSpace(string(current))
	go func() {
		defer func() { _ = watcher.Close() }()
		for {
			select {
			case <-ctx.Done():
				return
			case <-watcher.Errors:
			case <-watcher.Events:
				body, err := os.ReadFile(r.values.SessionTokenPath)
				if err != nil {
					continue
				}
				nextToken := strings.TrimSpace(string(body))
				if nextToken != "" && nextToken != currentToken {
					previousGeneration := auth.CredentialFingerprint(currentToken)
					currentToken = nextToken
					r.disconnectSessionTokenConsumers(previousGeneration)
				}
			}
		}
	}()
	return nil
}
