package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/aperture/aperture/internal/browser"
)

func pushBrowserInitialization(
	ctx context.Context,
	wrapperPort int,
	wrapperControlToken string,
	payload []byte,
) error {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/initialize", wrapperPort),
		bytes.NewReader(payload),
	)
	if err != nil {
		return fmt.Errorf("create browser initialization request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+wrapperControlToken)
	request.Header.Set("Content-Type", "application/json")

	response, err := (&http.Client{}).Do(request)
	if err != nil {
		return fmt.Errorf("initialize browser: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return fmt.Errorf("initialize browser: wrapper returned %s", response.Status)
	}
	var failure struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &failure); err == nil && failure.Error != "" {
		return fmt.Errorf("initialize browser: %s", failure.Error)
	}
	return fmt.Errorf("initialize browser: wrapper returned %s", response.Status)
}

func encodeBrowserInitialization(input browser.SessionInitialization) ([]byte, error) {
	if input.Empty() {
		return nil, nil
	}

	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(input); err != nil {
		return nil, fmt.Errorf("encode browser initialization: %w", err)
	}
	payload := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	if len(payload) > browser.MaxSessionInitializationBytes {
		return nil, ErrBrowserStateTooLarge
	}
	return payload, nil
}
