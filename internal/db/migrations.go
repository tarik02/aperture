package db

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/uptrace/bun"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

type migrationFile struct {
	version int
	name    string
	up      bool
	sql     string
}

// runMigrations applies pending up migrations in version order.
func runMigrations(ctx context.Context, tx bun.IDB) error {
	files, err := loadMigrationFiles()
	if err != nil {
		return err
	}

	current, err := currentMigrationVersion(ctx, tx)
	if err != nil {
		return err
	}

	for _, file := range files {
		if !file.up || file.version <= current {
			continue
		}

		if _, err := tx.ExecContext(ctx, file.sql); err != nil {
			return fmt.Errorf("apply migration %06d_%s: %w", file.version, file.name, err)
		}

		if _, err := tx.NewInsert().
			Model(&SchemaMigration{
				Version:   file.version,
				AppliedAt: NowUTC(),
			}).
			Exec(ctx); err != nil {
			return fmt.Errorf("record migration %06d_%s: %w", file.version, file.name, err)
		}

		current = file.version
	}

	return nil
}

func currentMigrationVersion(ctx context.Context, tx bun.IDB) (int, error) {
	exists, err := tableExists(ctx, tx, "schema_migrations")
	if err != nil {
		return 0, err
	}
	if !exists {
		return 0, nil
	}

	count, err := tx.NewSelect().Model((*SchemaMigration)(nil)).Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("read current migration version: %w", err)
	}
	if count == 0 {
		return 0, nil
	}

	var version int
	if err := tx.NewSelect().
		Model((*SchemaMigration)(nil)).
		Column("version").
		OrderExpr("version DESC").
		Limit(1).
		Scan(ctx, &version); err != nil {
		return 0, fmt.Errorf("read current migration version: %w", err)
	}

	return version, nil
}

func tableExists(ctx context.Context, tx bun.IDB, name string) (bool, error) {
	var count int
	if err := tx.NewRaw(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		name,
	).Scan(ctx, &count); err != nil {
		return false, fmt.Errorf("check table %s: %w", name, err)
	}
	return count > 0, nil
}

func loadMigrationFiles() ([]migrationFile, error) {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}

	files := make([]migrationFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		parsed, err := parseMigrationFilename(entry.Name())
		if err != nil {
			return nil, err
		}

		content, err := migrationFS.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}

		parsed.sql = string(content)
		files = append(files, parsed)
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].version == files[j].version {
			if files[i].up == files[j].up {
				return files[i].name < files[j].name
			}
			return files[i].up
		}
		return files[i].version < files[j].version
	})

	return files, nil
}

func parseMigrationFilename(name string) (migrationFile, error) {
	parts := strings.SplitN(name, "_", 2)
	if len(parts) != 2 {
		return migrationFile{}, fmt.Errorf("invalid migration filename %q", name)
	}

	version, err := strconv.Atoi(parts[0])
	if err != nil {
		return migrationFile{}, fmt.Errorf("invalid migration version in %q: %w", name, err)
	}

	remainder := parts[1]
	switch {
	case strings.HasSuffix(remainder, ".up.sql"):
		return migrationFile{
			version: version,
			name:    strings.TrimSuffix(remainder, ".up.sql"),
			up:      true,
		}, nil
	case strings.HasSuffix(remainder, ".down.sql"):
		return migrationFile{
			version: version,
			name:    strings.TrimSuffix(remainder, ".down.sql"),
			up:      false,
		}, nil
	default:
		return migrationFile{}, fmt.Errorf("invalid migration suffix in %q", name)
	}
}

// LatestMigrationVersion returns the highest embedded up migration version.
func LatestMigrationVersion() (int, error) {
	files, err := loadMigrationFiles()
	if err != nil {
		return 0, err
	}

	latest := 0
	for _, file := range files {
		if file.up && file.version > latest {
			latest = file.version
		}
	}
	return latest, nil
}
