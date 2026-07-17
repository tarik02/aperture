package browser

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

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
					currentToken = nextToken
					r.disconnectViewer()
				}
			}
		}
	}()
	return nil
}
