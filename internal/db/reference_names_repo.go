package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// ReferenceNames holds display names for ids that API resources refer to, so
// responses can show a name next to a bare id. A missing entry means the row
// is gone or has no name.
type ReferenceNames struct {
	Users     map[string]string
	APITokens map[string]string
	Tenants   map[string]string
	Sessions  map[string]string
	Snapshots map[string]string
}

// ReferenceIDs lists the ids to resolve, per kind.
type ReferenceIDs struct {
	Users     []string
	APITokens []string
	Tenants   []string
	Sessions  []string
	Snapshots []string
}

// ResolveReferenceNames loads display names for ids in a few batched queries.
// Users resolve to their display name, tenants to theirs, API tokens and
// snapshots to their name, and sessions to their label when they have one.
func (r *Repository) ResolveReferenceNames(ctx context.Context, ids ReferenceIDs) (ReferenceNames, error) {
	var names ReferenceNames
	var err error
	if names.Users, err = r.selectNames(ctx, "users", "display_name", ids.Users); err != nil {
		return ReferenceNames{}, err
	}
	if names.APITokens, err = r.selectNames(ctx, "api_tokens", "name", ids.APITokens); err != nil {
		return ReferenceNames{}, err
	}
	if names.Tenants, err = r.selectNames(ctx, "tenants", "display_name", ids.Tenants); err != nil {
		return ReferenceNames{}, err
	}
	if names.Sessions, err = r.selectNames(ctx, "sessions", "label", ids.Sessions); err != nil {
		return ReferenceNames{}, err
	}
	if names.Snapshots, err = r.selectNames(ctx, "snapshots", "name", ids.Snapshots); err != nil {
		return ReferenceNames{}, err
	}
	return names, nil
}

func (r *Repository) selectNames(ctx context.Context, table, nameColumn string, ids []string) (map[string]string, error) {
	names := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return names, nil
	}
	var rows []struct {
		ID   string  `bun:"id"`
		Name *string `bun:"name"`
	}
	if err := r.db.bun.NewSelect().
		Table(table).
		Column("id").
		ColumnExpr("? AS name", bun.Ident(nameColumn)).
		Where("id IN (?)", bun.List(ids)).
		Scan(ctx, &rows); err != nil {
		return nil, fmt.Errorf("select %s names: %w", table, err)
	}
	for _, row := range rows {
		if row.Name != nil && *row.Name != "" {
			names[row.ID] = *row.Name
		}
	}
	return names, nil
}
