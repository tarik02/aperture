package clientcli

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
)

func newSnapshotsCmd(conn *connection) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "snapshots",
		Aliases: []string{"snapshot"},
		Short:   "list and manage snapshots",
	}

	var (
		name    string
		deleted string
		cursor  string
		limit   int
	)
	list := &cobra.Command{
		Use:   "list",
		Short: "list snapshots, newest first",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			query := url.Values{}
			setIfPresent(query, "name", name)
			setIfPresent(query, "deleted", deleted)
			setIfPresent(query, "cursor", cursor)
			if limit > 0 {
				query.Set("limit", strconv.Itoa(limit))
			}
			return conn.run(cmd, http.MethodGet, "/api/snapshots", query, nil)
		},
	}
	list.Flags().StringVar(&name, "name", "", "substring of the snapshot name")
	list.Flags().StringVar(&deleted, "deleted", "", "active (default), deleted or all")
	list.Flags().StringVar(&cursor, "cursor", "", "cursor of the next page")
	list.Flags().IntVar(&limit, "limit", 0, "page size")

	snapshotPath := func(name, suffix string) string {
		return "/api/snapshots/" + url.PathEscape(name) + suffix
	}
	cmd.AddCommand(
		list,
		&cobra.Command{
			Use:   "delete NAME",
			Short: "delete a snapshot; sessions started from it keep running",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return conn.run(cmd, http.MethodDelete, snapshotPath(args[0], ""), nil, nil)
			},
		},
		&cobra.Command{
			Use:   "restore NAME",
			Short: "restore a deleted snapshot",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return conn.run(cmd, http.MethodPost, snapshotPath(args[0], "/restore"), nil, nil)
			},
		},
	)
	return cmd
}
