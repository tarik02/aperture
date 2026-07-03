package sudo

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aperture/aperture/internal/config"
)

func TestParseMountArgs(t *testing.T) {
	t.Parallel()

	sessionID := "018f1234-0000-7000-8000-000000000001"
	snapshotID := "018f1234-0000-7000-8000-000000000002"

	cases := []struct {
		name    string
		args    []string
		want    MountRequest
		wantErr error
	}{
		{
			name: "session only defaults empty",
			args: []string{sessionID},
			want: MountRequest{SessionID: sessionID, Empty: true},
		},
		{
			name: "explicit empty",
			args: []string{sessionID, "empty"},
			want: MountRequest{SessionID: sessionID, Empty: true},
		},
		{
			name: "snapshot id",
			args: []string{sessionID, snapshotID},
			want: MountRequest{SessionID: sessionID, BaseSnapshotID: snapshotID},
		},
		{
			name:    "too many args",
			args:    []string{sessionID, snapshotID, "extra"},
			wantErr: ErrInvalidArguments,
		},
		{
			name:    "invalid session id",
			args:    []string{"bad"},
			wantErr: ErrInvalidSessionID,
		},
		{
			name:    "invalid snapshot id",
			args:    []string{sessionID, "bad"},
			wantErr: ErrInvalidSnapshot,
		},
		{
			name:    "whitespace in session id",
			args:    []string{" " + sessionID},
			wantErr: ErrInvalidSessionID,
		},
		{
			name:    "unhyphenated session id",
			args:    []string{"018f123400007000800000000000000001"},
			wantErr: ErrInvalidSessionID,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := ParseMountArgs(tc.args)
			if tc.wantErr != nil {
				if err == nil {
					t.Fatalf("ParseMountArgs() expected error")
				}
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("error = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseMountArgs() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("request = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestParseUnmountArgs(t *testing.T) {
	t.Parallel()

	sessionID := "018f1234-0000-7000-8000-000000000003"

	got, err := ParseUnmountArgs([]string{sessionID})
	if err != nil {
		t.Fatalf("ParseUnmountArgs() error = %v", err)
	}
	if got != sessionID {
		t.Fatalf("session id = %q, want %q", got, sessionID)
	}

	if _, err := ParseUnmountArgs(nil); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("expected invalid arguments, got %v", err)
	}
	if _, err := ParseUnmountArgs([]string{"bad"}); !errors.Is(err, ErrInvalidSessionID) {
		t.Fatalf("expected invalid session id, got %v", err)
	}
}

func TestMountSessionCreatesTrustedDirectories(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	cfg := config.Config{
		StoreRoot:    filepath.Join(root, "store"),
		RuntimeRoot:  filepath.Join(root, "runtime"),
		ArtifactRoot: filepath.Join(root, "artifacts"),
	}

	sessionID := "018f1234-0000-7000-8000-000000000010"
	req := MountRequest{SessionID: sessionID, Empty: true}

	if err := MountSession(context.Background(), cfg, req); err != nil {
		t.Fatalf("MountSession() error = %v", err)
	}

	merged := filepath.Join(cfg.StoreRoot, "sessions", "01", "8f", sessionID, "merged")
	if _, err := os.Stat(merged); err != nil {
		t.Fatalf("stat merged dir: %v", err)
	}
}
