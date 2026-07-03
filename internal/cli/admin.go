package cli

import "github.com/spf13/cobra"

func newAdminCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "admin",
		Short: "system administration commands",
	}

	tenants := &cobra.Command{
		Use:   "tenants",
		Short: "tenant administration",
	}
	tenants.AddCommand(
		placeholder("create"),
		placeholder("list"),
		placeholder("update"),
		placeholder("delete"),
		placeholder("restore"),
	)

	tokens := &cobra.Command{
		Use:   "tokens",
		Short: "api token administration",
	}
	tokens.AddCommand(
		placeholder("create"),
		placeholder("revoke"),
	)

	cmd.AddCommand(
		placeholder("bootstrap"),
		tenants,
		tokens,
	)

	return cmd
}
