package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/db"
)

func TestBootstrapCommandIdempotent(t *testing.T) {
	configPath := writeTestConfig(t)

	root := newRootCmd()
	root.SetContext(context.Background())
	root.SetArgs([]string{"--config", configPath, "admin", "bootstrap", "--name", "bootstrap"})

	var stdout bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stdout)

	if err := root.Execute(); err != nil {
		t.Fatalf("first bootstrap: %v", err)
	}
	first := stdout.String()
	if !strings.Contains(first, "apt_") {
		t.Fatalf("bootstrap output missing token: %q", first)
	}

	stdout.Reset()
	if err := root.Execute(); err == nil {
		t.Fatal("expected second bootstrap to fail")
	}

	database, err := db.Open(context.Background(), filepath.Join(filepath.Dir(configPath), "store", "aperture.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	count, err := db.NewRepository(database).CountAPITokens(context.Background())
	if err != nil {
		t.Fatalf("count api tokens: %v", err)
	}
	if count != 1 {
		t.Fatalf("token count = %d, want 1", count)
	}
}

func TestBootstrapUsesConfiguredDatabasePath(t *testing.T) {
	configPath := writeTestConfig(t)
	dbPath := filepath.Join(filepath.Dir(configPath), "store", "aperture.db")

	root := newRootCmd()
	root.SetContext(context.Background())
	root.SetArgs([]string{"--config", configPath, "admin", "bootstrap"})
	var stdout bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stdout)

	if err := root.Execute(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("database file missing at %s: %v", dbPath, err)
	}
}
