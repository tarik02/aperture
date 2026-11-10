package clientcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// connection is how the command reaches the instance: the address, the
// credential and the selected tenant, each from a flag or the environment.
type connection struct {
	baseURL   string
	tokenFile string
	tenantID  string
}

func (c *connection) base() (*url.URL, error) {
	raw := strings.TrimSpace(c.baseURL)
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv(urlEnv))
	}
	if raw == "" {
		return nil, fmt.Errorf("no instance address: set %s or pass --url", urlEnv)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("instance address: %w", err)
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("instance address %q: want an http(s) address", raw)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed, nil
}

func (c *connection) token() (string, error) {
	if c.tokenFile != "" {
		data, err := os.ReadFile(c.tokenFile)
		if err != nil {
			return "", fmt.Errorf("read token file: %w", err)
		}
		if token := strings.TrimSpace(string(data)); token != "" {
			return token, nil
		}
		return "", fmt.Errorf("token file %s is empty", c.tokenFile)
	}
	if token := strings.TrimSpace(os.Getenv(tokenEnv)); token != "" {
		return token, nil
	}
	return "", fmt.Errorf("no token: set %s or pass --token-file", tokenEnv)
}

func (c *connection) tenant() string {
	if tenant := strings.TrimSpace(c.tenantID); tenant != "" {
		return tenant
	}
	return strings.TrimSpace(os.Getenv(tenantEnv))
}

// apiError is the instance's error envelope.
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("http %d: %s", e.Status, e.Message)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// call sends one API request and returns the answer body. The path is already
// escaped. A nil body sends none; a json.RawMessage is sent as it is.
func (c *connection) call(ctx context.Context, method, path string, query url.Values, body any) ([]byte, error) {
	endpoint, err := c.base()
	if err != nil {
		return nil, err
	}
	token, err := c.token()
	if err != nil {
		return nil, err
	}

	decoded, err := url.PathUnescape(path)
	if err != nil {
		return nil, fmt.Errorf("path %q: %w", path, err)
	}
	endpoint.RawPath = endpoint.EscapedPath() + path
	endpoint.Path += decoded
	endpoint.RawQuery = query.Encode()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if tenant := c.tenant(); tenant != "" {
		req.Header.Set("X-Aperture-Tenant-Id", tenant)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	answer, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read answer: %w", err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return answer, nil
	}

	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(answer, &envelope) == nil && envelope.Error.Code != "" {
		return nil, &apiError{Status: resp.StatusCode, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	return nil, &apiError{Status: resp.StatusCode, Message: strings.TrimSpace(string(answer))}
}

// run sends one API request and prints the answer.
func (c *connection) run(cmd *cobra.Command, method, path string, query url.Values, body any) error {
	answer, err := c.call(cmd.Context(), method, path, query, body)
	if err != nil {
		return err
	}
	return printJSON(cmd, answer)
}

func printJSON(cmd *cobra.Command, answer []byte) error {
	answer = bytes.TrimSpace(answer)
	if len(answer) == 0 {
		return nil
	}
	var indented bytes.Buffer
	if err := json.Indent(&indented, answer, "", "  "); err != nil {
		_, err = cmd.OutOrStdout().Write(append(answer, '\n'))
		return err
	}
	indented.WriteByte('\n')
	_, err := cmd.OutOrStdout().Write(indented.Bytes())
	return err
}

// pairs parses repeated arguments of the KEY=VALUE shape, keeping their order.
func pairs(kind, shape string, args []string) ([][2]string, error) {
	parsed := make([][2]string, 0, len(args))
	for _, arg := range args {
		key, value, found := strings.Cut(arg, "=")
		if !found || strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("%s %q: want %s", kind, arg, shape)
		}
		parsed = append(parsed, [2]string{strings.TrimSpace(key), value})
	}
	return parsed, nil
}

type proxyRule struct {
	Match string `json:"match"`
	Via   string `json:"via"`
}

// proxyRules parses MATCH=VIA arguments into ordered proxy rules.
func proxyRules(args []string) ([]proxyRule, error) {
	parsed, err := pairs("rule", "MATCH=VIA", args)
	if err != nil {
		return nil, err
	}
	rules := make([]proxyRule, 0, len(parsed))
	for _, pair := range parsed {
		via := strings.TrimSpace(pair[1])
		if via == "" {
			return nil, errors.New("rule " + pair[0] + ": want MATCH=VIA")
		}
		rules = append(rules, proxyRule{Match: pair[0], Via: via})
	}
	return rules, nil
}
