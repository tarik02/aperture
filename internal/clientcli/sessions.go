package clientcli

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
)

func newSessionsCmd(conn *connection) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "sessions",
		Aliases: []string{"session"},
		Short:   "create, inspect and manage browser sessions",
	}
	cmd.AddCommand(
		newSessionsListCmd(conn),
		newSessionsGetCmd(conn),
		newSessionsCreateCmd(conn),
		newSessionsProxyCmd(conn),
		newSessionsPromoteCmd(conn),
		newSessionActionCmd(conn, "suspend", "stop a running session and keep its state", http.MethodPost, "/suspend"),
		newSessionActionCmd(conn, "reopen", "reopen a retained deleted or failed session", http.MethodPost, "/reopen"),
		newSessionActionCmd(conn, "rotate-token", "replace the session token and invalidate the old one", http.MethodPost, "/session-token/rotate"),
		newSessionActionCmd(conn, "delete", "stop a session and remove its state for good", http.MethodDelete, ""),
	)
	return cmd
}

func sessionPath(id, suffix string) string {
	return "/api/sessions/" + url.PathEscape(id) + suffix
}

func newSessionsListCmd(conn *connection) *cobra.Command {
	var (
		active         bool
		includeDeleted bool
		status         string
		search         string
		sort           string
		cursor         string
		limit          int
	)
	cmd := &cobra.Command{
		Use:   "list",
		Short: "list sessions, newest first",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			query := url.Values{}
			if active {
				query.Set("active", "true")
			}
			if includeDeleted {
				query.Set("includeDeleted", "true")
			}
			setIfPresent(query, "status", status)
			setIfPresent(query, "query", search)
			setIfPresent(query, "sort", sort)
			setIfPresent(query, "cursor", cursor)
			if limit > 0 {
				query.Set("limit", strconv.Itoa(limit))
			}
			return conn.run(cmd, http.MethodGet, "/api/sessions", query, nil)
		},
	}
	cmd.Flags().BoolVar(&active, "active", false, "only creating, running or suspended sessions that have not expired")
	cmd.Flags().BoolVar(&includeDeleted, "include-deleted", false, "include deleted sessions")
	cmd.Flags().StringVar(&status, "status", "", "exact lifecycle status")
	cmd.Flags().StringVar(&search, "query", "", "substring of the label, ID or base snapshot name")
	cmd.Flags().StringVar(&sort, "sort", "", "createdAt (default) or lastConnectedAt")
	cmd.Flags().StringVar(&cursor, "cursor", "", "cursor of the next page")
	cmd.Flags().IntVar(&limit, "limit", 0, "page size")
	return cmd
}

func newSessionsGetCmd(conn *connection) *cobra.Command {
	return &cobra.Command{
		Use:   "get SESSION_ID",
		Short: "show a session with its credentials and proxy rules",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return conn.run(cmd, http.MethodGet, sessionPath(args[0], ""), nil, nil)
		},
	}
}

func newSessionActionCmd(conn *connection, name, short, method, suffix string) *cobra.Command {
	return &cobra.Command{
		Use:   name + " SESSION_ID",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return conn.run(cmd, method, sessionPath(args[0], suffix), nil, nil)
		},
	}
}

func newSessionsCreateCmd(conn *connection) *cobra.Command {
	var (
		channel     string
		snapshot    string
		label       string
		browserArgs []string
		open        []string
		tags        []string
		rules       []string
		noWait      bool
	)
	cmd := &cobra.Command{
		Use:   "create",
		Short: "start a browser session",
		Example: "  aperture-cli sessions create --channel chromium --snapshot signed-in --open https://example.com\n" +
			"  aperture-cli sessions create --channel chromium --rule localhost:3000=local",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			browser := map[string]any{"channel": channel}
			if len(browserArgs) > 0 {
				browser["args"] = browserArgs
			}
			body := map[string]any{"browser": browser}
			if snapshot != "" {
				body["baseSnapshotName"] = snapshot
			}
			if label != "" {
				body["label"] = label
			}
			if len(open) > 0 {
				targets := make([]map[string]string, 0, len(open))
				for _, target := range open {
					targets = append(targets, map[string]string{"url": target})
				}
				body["initialTargets"] = targets
			}
			if len(tags) > 0 {
				parsed, err := pairs("tag", "KEY=VALUE", tags)
				if err != nil {
					return err
				}
				values := make(map[string]string, len(parsed))
				for _, pair := range parsed {
					values[pair[0]] = pair[1]
				}
				body["tags"] = values
			}
			if len(rules) > 0 {
				parsed, err := proxyRules(rules)
				if err != nil {
					return err
				}
				body["proxy"] = map[string]any{"rules": parsed}
			}

			query := url.Values{}
			if noWait {
				query.Set("waitForReady", "false")
			}
			return conn.run(cmd, http.MethodPost, "/api/sessions", query, body)
		},
	}
	cmd.Flags().StringVar(&channel, "channel", "", "browser channel, one of `aperture-cli channels`")
	cmd.Flags().StringVar(&snapshot, "snapshot", "", "snapshot to start from (default: a blank session)")
	cmd.Flags().StringVar(&label, "label", "", "label shown to operators")
	cmd.Flags().StringArrayVar(&browserArgs, "browser-arg", nil, "additional Chromium argument (repeatable)")
	cmd.Flags().StringArrayVar(&open, "open", nil, "page to open instead of the startup page (repeatable)")
	cmd.Flags().StringArrayVar(&tags, "tag", nil, "KEY=VALUE tag (repeatable)")
	cmd.Flags().StringArrayVar(&rules, "rule", nil, "MATCH=VIA proxy rule, in order (repeatable)")
	cmd.Flags().BoolVar(&noWait, "no-wait", false, "return while the browser is still starting")
	_ = cmd.MarkFlagRequired("channel")
	return cmd
}

func newSessionsProxyCmd(conn *connection) *cobra.Command {
	var (
		clearRules bool
		drain      bool
	)
	cmd := &cobra.Command{
		Use:   "proxy SESSION_ID [MATCH=VIA...]",
		Short: "replace a session's proxy rules",
		Long: "Replaces the session's whole proxy configuration with the given rules, checked in order.\n\n" +
			"MATCH is host or host:port, with the host exact, *.suffix or *. VIA is direct, refuse, local,\n" +
			"or an inline proxy URL without a secret. local routes through the tunnel `aperture-cli tunnel`\n" +
			"attaches. Named upstreams carry secrets and are set through `aperture-cli api`.\n\n" +
			"The current rules are in `aperture-cli sessions get`.",
		Example: "  aperture-cli sessions proxy 01a1… localhost:3000=local localhost:5173=local\n" +
			"  aperture-cli sessions proxy 01a1… --clear",
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rules, err := proxyRules(args[1:])
			if err != nil {
				return err
			}
			if clearRules != (len(rules) == 0) {
				return errors.New("pass either rules or --clear")
			}
			body := map[string]any{"rules": rules, "drain": drain}
			return conn.run(cmd, http.MethodPut, sessionPath(args[0], "/proxy"), nil, body)
		},
	}
	cmd.Flags().BoolVar(&clearRules, "clear", false, "remove every rule")
	cmd.Flags().BoolVar(&drain, "drain", false, "reset live tunnel streams so open connections pick up the new rules")
	return cmd
}

func newSessionsPromoteCmd(conn *connection) *cobra.Command {
	var (
		name        string
		description string
		force       bool
	)
	cmd := &cobra.Command{
		Use:   "promote SESSION_ID",
		Short: "turn a stopped session into a snapshot",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"name": name, "force": force}
			if description != "" {
				body["description"] = description
			}
			return conn.run(cmd, http.MethodPost, sessionPath(args[0], "/promote"), nil, body)
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "snapshot name")
	cmd.Flags().StringVar(&description, "description", "", "snapshot description")
	cmd.Flags().BoolVar(&force, "force", false, "replace an active snapshot of the same name")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func setIfPresent(query url.Values, key, value string) {
	if value != "" {
		query.Set(key, value)
	}
}
