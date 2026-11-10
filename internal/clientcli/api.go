package clientcli

import (
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

func newChannelsCmd(conn *connection) *cobra.Command {
	return &cobra.Command{
		Use:   "channels",
		Short: "list the browser channels a session can start with",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return conn.run(cmd, http.MethodGet, "/api/browser/channels", nil, nil)
		},
	}
}

func newWhoamiCmd(conn *connection) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "show the principal and scopes behind the token",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return conn.run(cmd, http.MethodGet, "/api/auth/me", nil, nil)
		},
	}
}

func newAPICmd(conn *connection) *cobra.Command {
	var (
		data    string
		queries []string
	)
	cmd := &cobra.Command{
		Use:   "api METHOD PATH",
		Short: "send any API request",
		Long: "Sends one request to the instance with the configured token and prints the answer.\n" +
			"Covers what has no command of its own; the operations are in the instance's OpenAPI spec.",
		Example: "  aperture api GET /api/events --query limit=20\n" +
			"  aperture api PUT /api/sessions/01a1…/tags --data '{\"tags\":{\"suite\":\"checkout\"}}'\n" +
			"  aperture api POST /api/sessions --data @session.json",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			method := strings.ToUpper(args[0])
			path := args[1]
			if !strings.HasPrefix(path, "/") {
				return fmt.Errorf("path %q: want a path starting with /", path)
			}

			path, inline, _ := strings.Cut(path, "?")
			query, err := url.ParseQuery(inline)
			if err != nil {
				return fmt.Errorf("path query: %w", err)
			}
			parsed, err := pairs("query", "KEY=VALUE", queries)
			if err != nil {
				return err
			}
			for _, pair := range parsed {
				query.Add(pair[0], pair[1])
			}

			var body any
			if data != "" {
				raw, err := requestData(cmd, data)
				if err != nil {
					return err
				}
				if !json.Valid(raw) {
					return errors.New("data is not valid JSON")
				}
				body = json.RawMessage(raw)
			}
			return conn.run(cmd, method, path, query, body)
		},
	}
	cmd.Flags().StringVarP(&data, "data", "d", "", "JSON request body, @FILE to read a file, or - for standard input")
	cmd.Flags().StringArrayVarP(&queries, "query", "q", nil, "KEY=VALUE query parameter (repeatable)")
	return cmd
}

func requestData(cmd *cobra.Command, data string) ([]byte, error) {
	switch {
	case data == "-":
		return io.ReadAll(cmd.InOrStdin())
	case strings.HasPrefix(data, "@"):
		return os.ReadFile(strings.TrimPrefix(data, "@"))
	}
	return []byte(data), nil
}
