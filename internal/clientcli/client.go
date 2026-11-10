package clientcli

import (
	"bytes"
	"context"
	"encoding/json"
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
		token, err := readSecretFile(c.tokenFile)
		if err != nil {
			return "", fmt.Errorf("token file: %w", err)
		}
		return token, nil
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
	if body == nil {
		return c.send(ctx, method, path, query, "", nil)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	return c.send(ctx, method, path, query, "application/json", bytes.NewReader(encoded))
}

// send sends one API request with a body of the given content type and
// returns the answer body.
func (c *connection) send(ctx context.Context, method, path string, query url.Values, contentType string, payload io.Reader) ([]byte, error) {
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

	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
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

// proxyOptions are the flags that describe a session's proxy configuration
// beyond its rules: the named upstreams and their secrets.
type proxyOptions struct {
	upstreams []string
	authFiles []string
}

func (o *proxyOptions) register(cmd *cobra.Command) {
	cmd.Flags().StringArrayVar(&o.upstreams, "upstream", nil, "NAME=URL upstream a rule may route via; NAME=@FILE reads the URL from a file (repeatable)")
	cmd.Flags().StringArrayVar(&o.authFiles, "upstream-auth-file", nil, "NAME=FILE holding the bearer secret of a tunnel upstream (repeatable)")
}

// config builds the proxy configuration from MATCH=VIA rules and the upstream
// flags. Secrets come from files, so they stay out of the argument list.
func (o *proxyOptions) config(rules []string) (map[string]any, error) {
	parsedRules, err := pairs("rule", "MATCH=VIA", rules)
	if err != nil {
		return nil, err
	}
	ordered := make([]proxyRule, 0, len(parsedRules))
	for _, pair := range parsedRules {
		via := strings.TrimSpace(pair[1])
		if via == "" {
			return nil, fmt.Errorf("rule %q: want MATCH=VIA", pair[0])
		}
		ordered = append(ordered, proxyRule{Match: pair[0], Via: via})
	}

	type upstream struct {
		URL  string `json:"url"`
		Auth string `json:"auth,omitempty"`
	}
	upstreams := map[string]*upstream{}

	parsedUpstreams, err := pairs("upstream", "NAME=URL", o.upstreams)
	if err != nil {
		return nil, err
	}
	for _, pair := range parsedUpstreams {
		address := strings.TrimSpace(pair[1])
		if file, found := strings.CutPrefix(address, "@"); found {
			if address, err = readSecretFile(file); err != nil {
				return nil, fmt.Errorf("upstream %s: %w", pair[0], err)
			}
		}
		if address == "" {
			return nil, fmt.Errorf("upstream %s: want NAME=URL", pair[0])
		}
		upstreams[pair[0]] = &upstream{URL: address}
	}

	parsedAuth, err := pairs("upstream auth file", "NAME=FILE", o.authFiles)
	if err != nil {
		return nil, err
	}
	for _, pair := range parsedAuth {
		target, found := upstreams[pair[0]]
		if !found {
			return nil, fmt.Errorf("upstream auth file %s: no --upstream of that name", pair[0])
		}
		if target.Auth, err = readSecretFile(pair[1]); err != nil {
			return nil, fmt.Errorf("upstream %s: %w", pair[0], err)
		}
	}

	config := map[string]any{"rules": ordered}
	if len(upstreams) > 0 {
		config["upstreams"] = upstreams
	}
	return config, nil
}

func readSecretFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	secret := strings.TrimSpace(string(data))
	if secret == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return secret, nil
}
