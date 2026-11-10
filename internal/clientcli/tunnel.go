package clientcli

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/aperture/aperture/internal/proxy"
	"github.com/spf13/cobra"
)

func newTunnelCmd(conn *connection) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tunnel SESSION HOST:PORT...",
		Short: "attach a local tunnel so a session's browser reaches services on this machine",
		Long: "Attaches this machine as the local tunnel of a browser session and serves it until interrupted.\n\n" +
			"SESSION is a session ID on the configured instance, or the session's full address, for example\n" +
			"https://aperture.example/sessions/<id>. Each HOST:PORT is a service the browser may reach;\n" +
			"the session's proxy rules must route the same HOST:PORT via local. Anything else is refused.\n\n" +
			"The token needs owner access to the session: the session token (aps_) or an API token with\n" +
			"sessions:write.",
		Example: "  aperture sessions proxy 01a1… localhost:3000=local\n" +
			"  aperture tunnel 01a1… localhost:3000\n" +
			"  " + tokenEnv + "=aps_… aperture tunnel https://aperture.example/sessions/01a1… localhost:3000 localhost:5173",
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			tunnelURL, err := tunnelEndpoint(conn, args[0])
			if err != nil {
				return err
			}
			targets, err := tunnelTargets(args[1:])
			if err != nil {
				return err
			}
			token, err := conn.token()
			if err != nil {
				return err
			}

			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()

			client := proxy.LocalTunnelClient{
				URL:   tunnelURL,
				Token: token,
				Allow: func(target proxy.Target) bool {
					return targets[strings.ToLower(target.String())]
				},
				Attached: func() {
					cmd.PrintErrf("tunnel attached: %s\n", strings.Join(args[1:], ", "))
				},
				Refused: func(target proxy.Target, err error) {
					cmd.PrintErrf("refused %s: %v\n", target, err)
				},
			}
			err = client.Serve(ctx)
			switch {
			case errors.Is(err, proxy.ErrTunnelUnauthorized):
				return errors.New("the token has no owner access to this session")
			case errors.Is(err, proxy.ErrTunnelNotFound):
				return errors.New("no running session at this address")
			}
			return err
		},
	}

	return cmd
}

// tunnelEndpoint turns a session ID or address into its tunnel WebSocket URL.
// The web UI address (/-/sessions/<id>) names the same session and is accepted.
func tunnelEndpoint(conn *connection, session string) (string, error) {
	raw := session
	if !strings.Contains(session, "://") {
		base, err := conn.base()
		if err != nil {
			return "", err
		}
		raw = base.JoinPath("sessions", session).String()
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("session url: %w", err)
	}
	switch parsed.Scheme {
	case "https", "wss":
		parsed.Scheme = "wss"
	case "http", "ws":
		parsed.Scheme = "ws"
	default:
		return "", fmt.Errorf("session url %q: want an http(s) or ws(s) address", raw)
	}

	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	for index := len(segments) - 2; index >= 0; index-- {
		if segments[index] != "sessions" || segments[index+1] == "" {
			continue
		}
		base := segments[:index]
		if len(base) > 0 && base[len(base)-1] == "-" {
			base = base[:len(base)-1]
		}
		path := append(append([]string{}, base...), "sessions", segments[index+1], "tunnel")
		return (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host, Path: "/" + strings.Join(path, "/")}).String(), nil
	}
	return "", fmt.Errorf("session url %q: want …/sessions/<id>", raw)
}

func tunnelTargets(args []string) (map[string]bool, error) {
	targets := make(map[string]bool, len(args))
	for _, arg := range args {
		host, port, err := net.SplitHostPort(arg)
		if err != nil || host == "" {
			return nil, fmt.Errorf("target %q: want HOST:PORT", arg)
		}
		if number, err := strconv.ParseUint(port, 10, 16); err != nil || number == 0 {
			return nil, fmt.Errorf("target %q: invalid port", arg)
		}
		targets[strings.ToLower(net.JoinHostPort(host, port))] = true
	}
	return targets, nil
}
