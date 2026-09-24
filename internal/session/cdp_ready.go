package session

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

const (
	cdpReadyTimeout      = 45 * time.Second
	cdpReadyPollInterval = 500 * time.Millisecond
	cdpReadyRequestTime  = 2 * time.Second
)

// CDPReadyWaiter blocks until the session wrapper on wrapperPort serves CDP.
type CDPReadyWaiter func(ctx context.Context, wrapperPort int) error

// waitForCDPEndpoint polls the wrapper CDP discovery route until it answers.
// It probes the same route the public cdpUrl resolves to: the wrapper proxies
// /json/version to Chromium, so one success proves both that the wrapper API is
// listening and that the browser answers DevTools.
func waitForCDPEndpoint(ctx context.Context, wrapperPort int) error {
	if wrapperPort <= 0 {
		return fmt.Errorf("wait for cdp endpoint: wrapper port is not allocated")
	}

	ctx, cancel := context.WithTimeout(ctx, cdpReadyTimeout)
	defer cancel()

	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", wrapperPort)
	client := &http.Client{Timeout: cdpReadyRequestTime}
	ticker := time.NewTicker(cdpReadyPollInterval)
	defer ticker.Stop()

	for {
		lastErr := probeCDPEndpoint(ctx, client, url)
		if lastErr == nil {
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for cdp endpoint %s: %w: last attempt: %v", url, ctx.Err(), lastErr)
		case <-ticker.C:
		}
	}
}

func probeCDPEndpoint(ctx context.Context, client *http.Client, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	// The wrapper serves CDP discovery to the owner role only, which Traefik's
	// forward auth attaches to public requests.
	req.Header.Set("X-Aperture-Collaboration-Role", "owner")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %s", resp.Status)
	}
	return nil
}
