package browser

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/aperture/aperture/internal/paths"
)

const (
	sandboxTestSessionID      = "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b"
	sandboxTestOtherSessionID = "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5c"
)

type sandboxTestLayout struct {
	storeRoot      string
	runtimeDir     string
	session        string
	merged         string
	files          string
	cache          string
	extensionDir   string
	nativeHostPath string
}

func newSandboxTestLayout(t *testing.T) sandboxTestLayout {
	t.Helper()
	root := t.TempDir()
	storeRoot := filepath.Join(root, "var", "lib", "aperture")
	session := filepath.Join(storeRoot, "sessions", "01", "8f", sandboxTestSessionID)
	layout := sandboxTestLayout{
		storeRoot:      storeRoot,
		runtimeDir:     filepath.Join(root, "run", "user", "1000"),
		session:        session,
		merged:         filepath.Join(session, "merged"),
		files:          filepath.Join(session, "files"),
		cache:          filepath.Join(session, "cache"),
		extensionDir:   filepath.Join(root, "share", "aperture", "extensions", "tab-window-enforcer"),
		nativeHostPath: filepath.Join(root, "bin", "aperture-extension-native-host"),
	}
	for _, dir := range []string{
		layout.merged,
		layout.files,
		layout.cache,
		filepath.Join(session, "metadata"),
		filepath.Join(storeRoot, "sessions", "01", "8f", sandboxTestOtherSessionID, "merged"),
		filepath.Join(layout.runtimeDir, "aperture", "sessions"),
		layout.extensionDir,
		filepath.Dir(layout.nativeHostPath),
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	for _, file := range []string{
		filepath.Join(storeRoot, "aperture.db"),
		filepath.Join(session, "metadata", "session-token"),
		filepath.Join(layout.runtimeDir, "aperture", "job-token"),
		filepath.Join(layout.runtimeDir, "aperture", "sessions", sandboxTestSessionID+".env"),
		filepath.Join(layout.runtimeDir, "bus"),
		layout.nativeHostPath,
	} {
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			t.Fatalf("write %s: %v", file, err)
		}
	}
	t.Setenv("XDG_RUNTIME_DIR", layout.runtimeDir)
	return layout
}

// assertSandboxHidesServiceState checks the paths a compromised browser must never read: the store
// root with the database and other sessions, the service's runtime root and secrets, and its home.
func assertSandboxHidesServiceState(t *testing.T, args []string, layout sandboxTestLayout) {
	t.Helper()
	hidden := []string{
		layout.storeRoot,
		filepath.Join(layout.storeRoot, "aperture.db"),
		filepath.Join(layout.storeRoot, "sessions", "01", "8f", sandboxTestOtherSessionID, "merged"),
		filepath.Join(layout.session, "metadata", "session-token"),
		layout.runtimeDir,
		filepath.Join(layout.runtimeDir, "aperture", "job-token"),
		filepath.Join(layout.runtimeDir, "aperture", "sessions", sandboxTestSessionID+".env"),
		filepath.Join(layout.runtimeDir, "bus"),
		"/var/lib/aperture",
		"/var/lib/aperture/aperture.db",
		"/run/secrets",
		"/run/user/1000/aperture/job-token",
		"/run/user/1000/bus",
		"/run/aperture/state/job-token",
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		hidden = append(hidden, home, filepath.Join(home, ".local", "state", "aperture", "aperture.db"))
	}
	// A tmpfs can only cover an existing directory, so the configuration is masked where it exists.
	if _, err := os.Stat("/etc/aperture"); err == nil {
		hidden = append(hidden, "/etc/aperture/aperture.toml")
	}
	for _, path := range hidden {
		if sandboxExposes(args, path) {
			t.Errorf("sandbox exposes %s; args: %q", path, args)
		}
	}
}

func assertSandboxExposes(t *testing.T, args []string, hostPaths ...string) {
	t.Helper()
	for _, path := range hostPaths {
		if !sandboxExposes(args, path) {
			t.Errorf("sandbox does not expose %s; args: %q", path, args)
		}
	}
}

func assertSandboxFlags(t *testing.T, args []string, flags ...string) {
	t.Helper()
	for _, flag := range flags {
		if !slices.Contains(args, flag) {
			t.Errorf("bwrap args lack %s; args: %q", flag, args)
		}
	}
}

func TestBuildBwrapCommandIsolatesCompositorSession(t *testing.T) {
	layout := newSandboxTestLayout(t)
	socketName := "aperture-" + sandboxTestSessionID
	socketPath := filepath.Join(layout.runtimeDir, socketName)
	if err := os.WriteFile(socketPath, nil, 0o600); err != nil {
		t.Fatalf("write wayland socket: %v", err)
	}

	cmd, err := BuildBwrapCommand(LaunchConfig{
		BwrapPath:               "/usr/bin/bwrap",
		BrowserExecutable:       "/nix/store/00000000000000000000000000000000-chromium/bin/chromium",
		MergedUserDataDir:       layout.merged,
		FilesDir:                layout.files,
		CacheDir:                layout.cache,
		CDPPort:                 9222,
		TabWindowExtensionDir:   layout.extensionDir,
		ExtensionNativeHostPath: layout.nativeHostPath,
		ExtensionSocketPath:     filepath.Join(layout.cache, "extension.sock"),
		NestedWaylandSocket:     socketName,
		ProxyServerAddr:         "127.0.0.1:1080",
	})
	if err != nil {
		t.Fatalf("BuildBwrapCommand() error = %v", err)
	}
	args := bwrapSetupArgs(cmd.Args[1:])

	assertSandboxFlags(t, args, "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts")
	assertSandboxHidesServiceState(t, args, layout)
	assertSandboxExposes(
		t,
		args,
		layout.merged,
		layout.files,
		layout.cache,
		filepath.Join(layout.cache, "extension.sock"),
		layout.extensionDir,
		layout.nativeHostPath,
		socketPath,
	)
	if !hasSandboxBind(args, layout.files, paths.SandboxFilesRoot) {
		t.Errorf("sandbox does not mount files root at %s; args: %q", paths.SandboxFilesRoot, args)
	}
}

func TestBuildBwrapCommandIsolatesDesktopSession(t *testing.T) {
	layout := newSandboxTestLayout(t)
	waylandSocket := filepath.Join(layout.runtimeDir, "wayland-test")
	if err := os.WriteFile(waylandSocket, nil, 0o600); err != nil {
		t.Fatalf("write wayland socket: %v", err)
	}
	t.Setenv("WAYLAND_DISPLAY", "wayland-test")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path="+filepath.Join(layout.runtimeDir, "bus"))

	browserDir := filepath.Join(t.TempDir(), "chrome-linux")
	if err := os.MkdirAll(browserDir, 0o700); err != nil {
		t.Fatalf("mkdir browser dir: %v", err)
	}
	browserExecutable := filepath.Join(browserDir, "chrome")
	if err := os.WriteFile(browserExecutable, nil, 0o700); err != nil {
		t.Fatalf("write browser executable: %v", err)
	}

	cmd, err := BuildBwrapCommand(LaunchConfig{
		BwrapPath:         "/usr/bin/bwrap",
		BrowserExecutable: browserExecutable,
		MergedUserDataDir: layout.merged,
		FilesDir:          layout.files,
		CacheDir:          layout.cache,
		CDPPort:           9222,
	})
	if err != nil {
		t.Fatalf("BuildBwrapCommand() error = %v", err)
	}
	args := bwrapSetupArgs(cmd.Args[1:])

	assertSandboxFlags(t, args, "--die-with-parent", "--unshare-pid", "--unshare-uts")
	assertSandboxHidesServiceState(t, args, layout)
	assertSandboxExposes(t, args, layout.merged, layout.files, layout.cache, waylandSocket, browserDir)
	if !hasSandboxBind(args, layout.files, paths.SandboxFilesRoot) {
		t.Errorf("sandbox does not mount files root at %s; args: %q", paths.SandboxFilesRoot, args)
	}
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--setenv" && args[i+1] == "DBUS_SESSION_BUS_ADDRESS" {
			t.Errorf("sandbox receives the service's D-Bus session bus address; args: %q", args)
		}
	}
}

// bwrapSetupArgs returns the bwrap options before the browser command.
func bwrapSetupArgs(args []string) []string {
	if index := slices.Index(args, "--"); index >= 0 {
		return args[:index]
	}
	return args
}

type sandboxMount struct {
	source string
	dest   string
}

// sandboxMounts lists bwrap mounts in order. A source is empty for mounts that bring no host
// content, such as tmpfs, proc and dev, which hide whatever an earlier mount put below them.
func sandboxMounts(args []string) []sandboxMount {
	var mounts []sandboxMount
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--bind", "--ro-bind", "--dev-bind", "--bind-try", "--ro-bind-try", "--dev-bind-try":
			if i+2 < len(args) {
				mounts = append(mounts, sandboxMount{source: args[i+1], dest: args[i+2]})
			}
			i += 2
		case "--tmpfs", "--proc", "--dev":
			if i+1 < len(args) {
				mounts = append(mounts, sandboxMount{dest: args[i+1]})
			}
			i++
		case "--dir", "--remount-ro", "--chdir":
			i++
		case "--setenv", "--symlink":
			i += 2
		}
	}
	return mounts
}

// sandboxExposes reports whether hostPath is reachable inside the sandbox through a bind that no
// later mount covers.
func sandboxExposes(args []string, hostPath string) bool {
	mounts := sandboxMounts(args)
	for i, mount := range mounts {
		if mount.source == "" || !pathWithin(hostPath, mount.source) {
			continue
		}
		rel, err := filepath.Rel(mount.source, hostPath)
		if err != nil {
			continue
		}
		sandboxPath := filepath.Join(mount.dest, rel)
		covered := false
		for _, later := range mounts[i+1:] {
			if pathWithin(sandboxPath, later.dest) {
				covered = true
				break
			}
		}
		if !covered {
			return true
		}
	}
	return false
}

func hasSandboxBind(args []string, source string, dest string) bool {
	return slices.Contains(sandboxMounts(args), sandboxMount{source: source, dest: dest})
}

func pathWithin(path string, root string) bool {
	return path == root || root == "/" || strings.HasPrefix(path, root+string(os.PathSeparator))
}
