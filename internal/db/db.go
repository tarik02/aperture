package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"
)

// DB owns the SQLite connection and Bun handle.
type DB struct {
	sql *sql.DB
	bun *bun.DB
}

// Open connects to SQLite at databasePath and configures Bun.
func Open(ctx context.Context, databasePath string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}

	sqldb, err := sql.Open(sqliteshim.ShimName, databasePath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	sqldb.SetMaxOpenConns(1)

	if _, err := sqldb.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		_ = sqldb.Close()
		return nil, fmt.Errorf("enable sqlite foreign keys: %w", err)
	}
	if _, err := sqldb.ExecContext(ctx, "PRAGMA busy_timeout = 5000"); err != nil {
		_ = sqldb.Close()
		return nil, fmt.Errorf("set sqlite busy timeout: %w", err)
	}

	bundb := bun.NewDB(sqldb, sqlitedialect.New())
	RegisterModels(bundb)

	if err := bundb.PingContext(ctx); err != nil {
		_ = bundb.Close()
		return nil, fmt.Errorf("ping sqlite database: %w", err)
	}

	return &DB{
		sql: sqldb,
		bun: bundb,
	}, nil
}

// Close releases database resources.
func (d *DB) Close() error {
	if d == nil || d.bun == nil {
		return nil
	}
	return d.bun.Close()
}

// Bun returns the underlying Bun handle for repository code in this package.
func (d *DB) Bun() *bun.DB {
	return d.bun
}

// SQL returns the underlying database/sql handle.
func (d *DB) SQL() *sql.DB {
	return d.sql
}

// Migrate runs pending embedded SQL migrations under a write lock.
func (d *DB) Migrate(ctx context.Context) error {
	conn, err := d.bun.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return fmt.Errorf("disable sqlite foreign keys for migrations: %w", err)
	}

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin migration transaction: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		}
		_, _ = conn.ExecContext(context.Background(), "PRAGMA foreign_keys = ON")
	}()

	if err := runMigrations(ctx, conn); err != nil {
		return err
	}
	if err := checkSQLiteForeignKeys(ctx, conn); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("commit migration transaction: %w", err)
	}
	committed = true
	return nil
}

func checkSQLiteForeignKeys(ctx context.Context, tx bun.IDB) error {
	rows, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("check sqlite foreign keys: %w", err)
	}
	defer rows.Close()

	if !rows.Next() {
		return rows.Err()
	}

	var table string
	var rowID sql.NullInt64
	var parent string
	var fkID int
	if err := rows.Scan(&table, &rowID, &parent, &fkID); err != nil {
		return fmt.Errorf("read sqlite foreign key check row: %w", err)
	}
	if rowID.Valid {
		return fmt.Errorf("sqlite foreign key check failed: table %s rowid %d references %s fk %d", table, rowID.Int64, parent, fkID)
	}
	return fmt.Errorf("sqlite foreign key check failed: table %s references %s fk %d", table, parent, fkID)
}

// Repository provides transactional helpers for orchestration metadata access.
type Repository struct {
	db *DB
}

// NewRepository constructs a repository backed by db.
func NewRepository(db *DB) *Repository {
	return &Repository{db: db}
}

// WithTx runs fn inside a standard Bun transaction.
func (r *Repository) WithTx(ctx context.Context, fn func(ctx context.Context, tx bun.Tx) error) error {
	return r.db.bun.RunInTx(ctx, &sql.TxOptions{}, fn)
}

// WithImmediateTx runs fn inside a BEGIN IMMEDIATE transaction.
func (r *Repository) WithImmediateTx(ctx context.Context, fn func(ctx context.Context, tx bun.IDB) error) error {
	return r.db.WithImmediateTx(ctx, fn)
}

// NowUTC returns the current UTC timestamp in RFC3339Nano format.
func NowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
