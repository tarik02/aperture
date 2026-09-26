package snapshot

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/uptrace/bun/driver/sqliteshim"
)

// Chromium's History database keeps a record of every download. The files it
// points at are session files, which never enter a snapshot, so the records go
// too.
var downloadHistoryTables = []string{"downloads", "downloads_url_chains", "downloads_slices"}

func clearDownloadHistory(ctx context.Context, profileRoot string) error {
	histories, err := filepath.Glob(filepath.Join(profileRoot, "*", "History"))
	if err != nil {
		return err
	}
	for _, history := range histories {
		if err := clearProfileDownloadHistory(ctx, history); err != nil {
			return fmt.Errorf("clear download history %s: %w", filepath.Base(filepath.Dir(history)), err)
		}
	}
	return nil
}

// clearProfileDownloadHistory edits a copy and swaps it in, because materialized
// files unchanged since the base snapshot are hard links into that snapshot.
func clearProfileDownloadHistory(ctx context.Context, history string) error {
	info, err := os.Lstat(history)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	temp := history + ".aperture-edit"
	if err := copyRegularFile(history, temp, info.Mode().Perm()); err != nil {
		return err
	}
	if err := deleteDownloadRows(ctx, temp); err != nil {
		_ = os.Remove(temp)
		return err
	}
	if err := os.Rename(temp, history); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

func deleteDownloadRows(ctx context.Context, database string) (err error) {
	conn, err := sql.Open(sqliteshim.ShimName, database)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := conn.Close(); err == nil {
			err = closeErr
		}
	}()
	for _, table := range downloadHistoryTables {
		var count int
		if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			continue
		}
		if _, err := conn.ExecContext(ctx, "DELETE FROM "+table); err != nil {
			return err
		}
	}
	return nil
}

func copyRegularFile(source, destination string, mode os.FileMode) (err error) {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
	}()
	_, err = io.Copy(out, in)
	return err
}
