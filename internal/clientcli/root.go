// Package clientcli is the aperture command: the client of a running
// Aperture instance, for machines that do not run Aperture themselves.
package clientcli

import (
	"github.com/aperture/aperture/internal/version"
	"github.com/spf13/cobra"
)

const (
	urlEnv    = "APERTURE_URL"
	tokenEnv  = "APERTURE_TOKEN"
	tenantEnv = "APERTURE_TENANT_ID"
)

// Execute runs the aperture command.
func Execute() error {
	return newRootCmd().Execute()
}

func newRootCmd() *cobra.Command {
	conn := &connection{}

	cmd := &cobra.Command{
		Use:   "aperture",
		Short: "client for a running Aperture instance",
		Long: "Client for a running Aperture instance. Answers are the API's JSON; lists are tables at a\n" +
			"terminal and JSON in a pipe, or as --format says.\n\n" +
			"The instance comes from --url or " + urlEnv + ", the token from --token-file or " + tokenEnv + ".\n" +
			"A system-admin token selects a tenant with --tenant or " + tenantEnv + ".",
		Version:       version.Short(),
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	cmd.SetVersionTemplate("{{.Name}} {{.Version}}\n")

	cmd.PersistentFlags().StringVar(&conn.baseURL, "url", "", "instance address (default: "+urlEnv+")")
	cmd.PersistentFlags().StringVar(&conn.tokenFile, "token-file", "", "file holding the token (default: "+tokenEnv+")")
	cmd.PersistentFlags().StringVar(&conn.format, "format", "", "how lists are printed: table or json (default: table at a terminal, json otherwise)")
	cmd.PersistentFlags().StringVar(&conn.tenantID, "tenant", "", "tenant ID for a token that covers several (default: "+tenantEnv+")")

	cmd.AddCommand(
		newSessionsCmd(conn),
		newSnapshotsCmd(conn),
		newRecordingsCmd(conn),
		newFilesCmd(conn),
		newTunnelCmd(conn),
		newChannelsCmd(conn),
		newWhoamiCmd(conn),
		newAPICmd(conn),
	)

	return cmd
}
