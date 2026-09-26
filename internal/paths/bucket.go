package paths

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/ids"
)

// SessionLayout holds derived filesystem paths for a session.
type SessionLayout struct {
	SessionID string
	Root      string
	Upper     string
	Work      string
	Merged    string
	Cache     string
	Metadata  string
	Files     SessionFilesLayout
	// Artifacts holds operational output such as logs and crash dumps, which are
	// not session files.
	Artifacts  string
	Logs       string
	CrashDumps string
	RuntimeEnv string
}

// SessionFilesLayout holds the single root of a session's files and the
// directories below it that the browser, recorder, uploads, and Playwright MCP
// write to. Session file relative paths are relative to Root.
type SessionFilesLayout struct {
	Root       string
	Downloads  string
	Recordings string
	Uploads    string
	Outputs    string
}

// SandboxFilesRoot is where the browser sandbox mounts a session's files root.
// It is the same for every session, so paths below it can be handed to CDP
// clients and stored in browser profiles without revealing host paths.
const SandboxFilesRoot = "/session/files"

// SessionFiles derives the session file directories below root.
func SessionFiles(root string) SessionFilesLayout {
	return SessionFilesLayout{
		Root:       root,
		Downloads:  filepath.Join(root, "downloads"),
		Recordings: filepath.Join(root, "recordings"),
		Uploads:    filepath.Join(root, "uploads"),
		Outputs:    filepath.Join(root, "outputs"),
	}
}

// SnapshotLayout holds derived filesystem paths for a snapshot.
type SnapshotLayout struct {
	SnapshotID string
	Root       string
	Profile    string
}

// BucketPrefix returns the two-level bucket prefix for an id, e.g. "01/8f".
func BucketPrefix(id string) (string, error) {
	if err := ids.ValidateUUIDv7(id); err != nil {
		return "", fmt.Errorf("validate id: %w", err)
	}

	normalized := strings.ReplaceAll(id, "-", "")
	if len(normalized) < 4 {
		return "", fmt.Errorf("id too short for bucket prefix")
	}

	prefix := normalized[:4]
	return prefix[0:2] + "/" + prefix[2:4], nil
}

// Session derives session filesystem paths from trusted config roots and id.
func Session(cfg config.Config, sessionID string) (SessionLayout, error) {
	if err := ids.ValidateUUIDv7(sessionID); err != nil {
		return SessionLayout{}, fmt.Errorf("session id: %w", err)
	}

	bucket, err := BucketPrefix(sessionID)
	if err != nil {
		return SessionLayout{}, err
	}

	root, err := JoinUnderRoot(cfg.StoreRoot, "sessions", bucket, sessionID)
	if err != nil {
		return SessionLayout{}, err
	}

	artifactsRoot, err := JoinUnderRoot(cfg.ArtifactRoot, bucket, sessionID)
	if err != nil {
		return SessionLayout{}, err
	}

	runtimeEnv, err := JoinUnderRoot(cfg.RuntimeRoot, "sessions", sessionID+".env")
	if err != nil {
		return SessionLayout{}, err
	}

	return SessionLayout{
		SessionID:  sessionID,
		Root:       root,
		Upper:      filepath.Join(root, "upper"),
		Work:       filepath.Join(root, "work"),
		Merged:     filepath.Join(root, "merged"),
		Cache:      filepath.Join(root, "cache"),
		Metadata:   filepath.Join(root, "metadata"),
		Files:      SessionFiles(filepath.Join(root, "files")),
		Artifacts:  artifactsRoot,
		Logs:       filepath.Join(artifactsRoot, "logs"),
		CrashDumps: filepath.Join(artifactsRoot, "crash-dumps"),
		RuntimeEnv: runtimeEnv,
	}, nil
}

// Snapshot derives snapshot filesystem paths from trusted config roots and id.
func Snapshot(cfg config.Config, snapshotID string) (SnapshotLayout, error) {
	if err := ids.ValidateUUIDv7(snapshotID); err != nil {
		return SnapshotLayout{}, fmt.Errorf("snapshot id: %w", err)
	}

	bucket, err := BucketPrefix(snapshotID)
	if err != nil {
		return SnapshotLayout{}, err
	}

	root, err := JoinUnderRoot(cfg.StoreRoot, "snapshots", bucket, snapshotID)
	if err != nil {
		return SnapshotLayout{}, err
	}

	return SnapshotLayout{
		SnapshotID: snapshotID,
		Root:       root,
		Profile:    filepath.Join(root, "profile"),
	}, nil
}

// EmptyLowerDir returns the configured empty overlay lower directory.
func EmptyLowerDir(cfg config.Config) (string, error) {
	return JoinUnderRoot(cfg.StoreRoot, "empty-lower")
}
