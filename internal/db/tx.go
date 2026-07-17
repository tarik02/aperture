package db

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// WithTx runs fn inside a standard Bun transaction.
func (d *DB) WithTx(ctx context.Context, fn func(ctx context.Context, tx bun.Tx) error) error {
	return d.bun.RunInTx(ctx, nil, fn)
}

// WithImmediateTx runs fn inside a transaction that acquires SQLite's write lock up front.
func (d *DB) WithImmediateTx(ctx context.Context, fn func(ctx context.Context, tx bun.IDB) error) error {
	conn, err := d.bun.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin immediate: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	if err := fn(ctx, conn); err != nil {
		return err
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("commit immediate transaction: %w", err)
	}
	committed = true
	return nil
}
