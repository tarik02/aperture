package browser

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

func (r *wrapperRuntime) watchCDPToken(ctx context.Context) error {
	if r.values.CDPTokenPath == "" {
		return nil
	}
	current, err := os.ReadFile(r.values.CDPTokenPath)
	if err != nil {
		return fmt.Errorf("read cdp token: %w", err)
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("watch cdp token: %w", err)
	}
	if err := watcher.Add(filepath.Dir(r.values.CDPTokenPath)); err != nil {
		watcher.Close()
		return fmt.Errorf("watch cdp token directory: %w", err)
	}
	currentToken := strings.TrimSpace(string(current))
	go func() {
		defer watcher.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case <-watcher.Errors:
			case <-watcher.Events:
				body, err := os.ReadFile(r.values.CDPTokenPath)
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
