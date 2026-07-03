package db

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/aperture/aperture/internal/config"
	"github.com/uptrace/bun"
)

func TestMigrateFromEmptyDatabase(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "aperture.db")

	database, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	latest, err := LatestMigrationVersion()
	if err != nil {
		t.Fatalf("latest migration version: %v", err)
	}

	count, err := database.Bun().NewSelect().Model((*SchemaMigration)(nil)).Count(ctx)
	if err != nil {
		t.Fatalf("count schema migrations: %v", err)
	}
	if count != 1 {
		t.Fatalf("applied migrations = %d, want 1", count)
	}

	var version int
	if err := database.Bun().NewSelect().
		Model((*SchemaMigration)(nil)).
		Column("version").
		Scan(ctx, &version); err != nil {
		t.Fatalf("read applied migration version: %v", err)
	}
	if version != latest {
		t.Fatalf("applied version = %d, want %d", version, latest)
	}

	for _, table := range []string{
		"tenants",
		"api_tokens",
		"snapshots",
		"sessions",
		"session_tokens",
		"session_tags",
		"snapshot_tags",
		"events",
	} {
		exists, err := tableExistsOnConn(ctx, database, table)
		if err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("expected table %s to exist", table)
		}
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "aperture.db")

	database, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

func TestRepositoryWithTxCommits(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "aperture.db")

	database, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	repo := NewRepository(database)
	tenantID := "018f1234-0000-7000-8000-000000000001"
	createdAt := NowUTC()

	err = repo.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		_, err := tx.NewInsert().Model(&Tenant{
			ID:          tenantID,
			DisplayName: "test-tenant",
			CreatedAt:   createdAt,
		}).Exec(ctx)
		return err
	})
	if err != nil {
		t.Fatalf("insert tenant in transaction: %v", err)
	}

	count, err := database.Bun().NewSelect().Model((*Tenant)(nil)).Count(ctx)
	if err != nil {
		t.Fatalf("count tenants: %v", err)
	}
	if count != 1 {
		t.Fatalf("tenant count = %d, want 1", count)
	}
}

func TestRepositoryWithTxRollsBack(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "aperture.db")

	database, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}

	repo := NewRepository(database)
	err = repo.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(&Tenant{
			ID:          "018f1234-0000-7000-8000-000000000002",
			DisplayName: "rollback-tenant",
			CreatedAt:   NowUTC(),
		}).Exec(ctx); err != nil {
			return err
		}
		return errRollback
	})
	if !errors.Is(err, errRollback) {
		t.Fatalf("expected rollback error, got %v", err)
	}

	count, err := database.Bun().NewSelect().Model((*Tenant)(nil)).Count(ctx)
	if err != nil {
		t.Fatalf("count tenants: %v", err)
	}
	if count != 0 {
		t.Fatalf("tenant count = %d, want 0 after rollback", count)
	}
}

func TestOpenUsesConfiguredDatabasePath(t *testing.T) {
	t.Parallel()

	cfg := config.Config{
		DatabasePath: filepath.Join(t.TempDir(), "nested", "aperture.db"),
	}

	ctx := context.Background()
	database, err := Open(ctx, cfg.DatabasePath)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
}

var errRollback = errors.New("rollback")

func tableExistsOnConn(ctx context.Context, db *DB, name string) (bool, error) {
	var count int
	if err := db.Bun().NewRaw(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		name,
	).Scan(ctx, &count); err != nil {
		return false, err
	}
	return count > 0, nil
}
