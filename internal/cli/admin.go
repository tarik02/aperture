package cli

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aperture/aperture/internal/app"
	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/spf13/cobra"
)

func newAdminCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "admin",
		Short: "system administration commands",
	}

	cmd.AddCommand(
		newBootstrapCmd(),
		newAdminTenantsCmd(),
		newAdminTokensCmd(),
	)

	return cmd
}

func newBootstrapCmd() *cobra.Command {
	var name string
	var expiresAt string

	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "create the initial system-admin api token",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			var expires *time.Time
			if strings.TrimSpace(expiresAt) != "" {
				parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
				if err != nil {
					return fmt.Errorf("parse expires-at: %w", err)
				}
				parsed = parsed.UTC()
				expires = &parsed
			}

			created, err := application.Auth.Bootstrap(cmd.Context(), auth.BootstrapInput{
				Name:      name,
				ExpiresAt: expires,
			})
			if err != nil {
				return err
			}

			fmt.Fprintln(cmd.OutOrStdout(), "bootstrap token (store securely, shown once):")
			fmt.Fprintln(cmd.OutOrStdout(), created.Raw)
			return nil
		},
	}

	cmd.Flags().StringVar(&name, "name", "bootstrap", "token name")
	cmd.Flags().StringVar(&expiresAt, "expires-at", "", "optional RFC3339Nano expiration")

	return cmd
}

func newAdminTenantsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tenants",
		Short: "tenant administration",
	}

	cmd.AddCommand(
		newAdminTenantsCreateCmd(),
		newAdminTenantsListCmd(),
		newAdminTenantsUpdateCmd(),
		newAdminTenantsDeleteCmd(),
		newAdminTenantsRestoreCmd(),
	)

	return cmd
}

func newAdminTenantsCreateCmd() *cobra.Command {
	var displayName string

	cmd := &cobra.Command{
		Use:   "create",
		Short: "create a tenant",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			tenant, err := application.Auth.CreateTenant(cmd.Context(), auth.CreateTenantInput{
				DisplayName: displayName,
			})
			if err != nil {
				return err
			}

			printTenant(cmd.OutOrStdout(), tenant)
			return nil
		},
	}

	cmd.Flags().StringVar(&displayName, "display-name", "", "tenant display name")
	_ = cmd.MarkFlagRequired("display-name")

	return cmd
}

func newAdminTenantsListCmd() *cobra.Command {
	var includeDeleted bool

	cmd := &cobra.Command{
		Use:   "list",
		Short: "list tenants",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			tenants, err := application.Auth.ListTenants(cmd.Context(), includeDeleted)
			if err != nil {
				return err
			}

			for _, tenant := range tenants {
				printTenant(cmd.OutOrStdout(), &tenant)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&includeDeleted, "include-deleted", false, "include deactivated tenants")

	return cmd
}

func newAdminTenantsUpdateCmd() *cobra.Command {
	var tenantID string
	var displayName string

	cmd := &cobra.Command{
		Use:   "update",
		Short: "update tenant display name",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			tenant, err := application.Auth.UpdateTenant(cmd.Context(), tenantID, auth.UpdateTenantInput{
				DisplayName: displayName,
			})
			if err != nil {
				return err
			}

			printTenant(cmd.OutOrStdout(), tenant)
			return nil
		},
	}

	cmd.Flags().StringVar(&tenantID, "id", "", "tenant id")
	cmd.Flags().StringVar(&displayName, "display-name", "", "tenant display name")
	_ = cmd.MarkFlagRequired("id")
	_ = cmd.MarkFlagRequired("display-name")

	return cmd
}

func newAdminTenantsDeleteCmd() *cobra.Command {
	var tenantID string

	cmd := &cobra.Command{
		Use:   "delete",
		Short: "deactivate a tenant",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			tenant, err := application.Auth.DeleteTenant(cmd.Context(), tenantID)
			if err != nil {
				return err
			}

			printTenant(cmd.OutOrStdout(), tenant)
			return nil
		},
	}

	cmd.Flags().StringVar(&tenantID, "id", "", "tenant id")
	_ = cmd.MarkFlagRequired("id")

	return cmd
}

func newAdminTenantsRestoreCmd() *cobra.Command {
	var tenantID string

	cmd := &cobra.Command{
		Use:   "restore",
		Short: "restore a deactivated tenant",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			tenant, err := application.Auth.RestoreTenant(cmd.Context(), tenantID)
			if err != nil {
				return err
			}

			printTenant(cmd.OutOrStdout(), tenant)
			return nil
		},
	}

	cmd.Flags().StringVar(&tenantID, "id", "", "tenant id")
	_ = cmd.MarkFlagRequired("id")

	return cmd
}

func newAdminTokensCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tokens",
		Short: "api token administration",
	}

	cmd.AddCommand(
		newAdminTokensCreateCmd(),
		newAdminTokensRevokeCmd(),
	)

	return cmd
}

func newAdminTokensCreateCmd() *cobra.Command {
	var name string
	var authorityType string
	var tenantID string
	var scopes []string
	var expiresAt string

	cmd := &cobra.Command{
		Use:   "create",
		Short: "create an api token",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			var expires *time.Time
			if strings.TrimSpace(expiresAt) != "" {
				parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
				if err != nil {
					return fmt.Errorf("parse expires-at: %w", err)
				}
				parsed = parsed.UTC()
				expires = &parsed
			}

			input := auth.CreateTokenInput{
				AuthorityType: authorityType,
				Name:          name,
				Scopes:        scopes,
				ExpiresAt:     expires,
			}
			if strings.TrimSpace(tenantID) != "" {
				copyID := tenantID
				input.TenantID = &copyID
			}

			created, err := application.Auth.CreateToken(cmd.Context(), input)
			if err != nil {
				return err
			}

			fmt.Fprintln(cmd.OutOrStdout(), "api token (store securely, shown once):")
			fmt.Fprintln(cmd.OutOrStdout(), created.Raw)
			printToken(cmd.OutOrStdout(), &created.Token)
			return nil
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "token name")
	cmd.Flags().StringVar(&authorityType, "authority-type", "", "system_admin or tenant")
	cmd.Flags().StringVar(&tenantID, "tenant-id", "", "tenant id for tenant-scoped tokens")
	cmd.Flags().StringSliceVar(&scopes, "scopes", nil, "token scopes")
	cmd.Flags().StringVar(&expiresAt, "expires-at", "", "optional RFC3339Nano expiration")
	_ = cmd.MarkFlagRequired("name")
	_ = cmd.MarkFlagRequired("authority-type")
	_ = cmd.MarkFlagRequired("scopes")

	return cmd
}

func newAdminTokensRevokeCmd() *cobra.Command {
	var tokenID string

	cmd := &cobra.Command{
		Use:   "revoke",
		Short: "revoke an api token",
		RunE: func(cmd *cobra.Command, args []string) error {
			application, err := openApp(cmd)
			if err != nil {
				return err
			}
			defer application.Close()

			if err := application.Migrate(cmd.Context()); err != nil {
				return err
			}

			if err := application.Auth.RevokeToken(cmd.Context(), tokenID, nil); err != nil {
				return err
			}

			fmt.Fprintf(cmd.OutOrStdout(), "revoked token %s\n", tokenID)
			return nil
		},
	}

	cmd.Flags().StringVar(&tokenID, "id", "", "token id")
	_ = cmd.MarkFlagRequired("id")

	return cmd
}

func openApp(cmd *cobra.Command) (*app.App, error) {
	cfg, err := config.Load(rootFlags)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}

	application, err := app.New(cmd.Context(), cfg)
	if err != nil {
		return nil, fmt.Errorf("init app: %w", err)
	}
	return application, nil
}

func printTenant(out io.Writer, tenant *db.Tenant) {
	deleted := "active"
	if tenant.DeletedAt != nil {
		deleted = *tenant.DeletedAt
	}
	fmt.Fprintf(
		out,
		"tenant id=%s display_name=%q created_at=%s deleted_at=%s\n",
		tenant.ID,
		tenant.DisplayName,
		tenant.CreatedAt,
		deleted,
	)
}

func printToken(out io.Writer, token *db.APIToken) {
	tenant := ""
	if token.TenantID != nil {
		tenant = *token.TenantID
	}
	fmt.Fprintf(
		out,
		"token id=%s authority_type=%s tenant_id=%s name=%q scopes=%s\n",
		token.ID,
		token.AuthorityType,
		tenant,
		token.Name,
		token.ScopesJSON,
	)
}
