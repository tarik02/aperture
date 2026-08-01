package browser

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
)

const (
	extensionNativeMessageLimit = 1024 * 1024
	extensionNativeHostName     = "me.tarik02.aperture.tab_window_enforcer"
)

func installExtensionNativeHost(userDataDir string, executable string) error {
	manifest, err := json.MarshalIndent(map[string]any{
		"name":            extensionNativeHostName,
		"description":     "Aperture tab window enforcement bridge",
		"path":            executable,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + tabWindowEnforcerExtensionID + "/"},
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode extension native host manifest: %w", err)
	}
	hostDir := filepath.Join(userDataDir, "NativeMessagingHosts")
	if err := os.MkdirAll(hostDir, 0o700); err != nil {
		return fmt.Errorf("mkdir extension native host dir: %w", err)
	}
	if err := os.WriteFile(filepath.Join(hostDir, extensionNativeHostName+".json"), append(manifest, '\n'), 0o600); err != nil {
		return fmt.Errorf("write extension native host manifest: %w", err)
	}
	return nil
}

// RunExtensionNativeHost proxies Chromium native messages to the session wrapper socket.
func RunExtensionNativeHost() error {
	socketPath := strings.TrimSpace(os.Getenv("APERTURE_EXTENSION_SOCKET"))
	if socketPath == "" {
		return fmt.Errorf("APERTURE_EXTENSION_SOCKET is required")
	}

	for {
		var size uint32
		if err := binary.Read(os.Stdin, binary.LittleEndian, &size); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read native message size: %w", err)
		}
		if size == 0 || size > extensionNativeMessageLimit {
			return fmt.Errorf("invalid native message size %d", size)
		}
		body := make([]byte, size)
		if _, err := io.ReadFull(os.Stdin, body); err != nil {
			return fmt.Errorf("read native message: %w", err)
		}

		connection, err := net.Dial("unix", socketPath)
		if err != nil {
			return fmt.Errorf("connect extension wrapper socket: %w", err)
		}
		if _, err := connection.Write(append(body, '\n')); err != nil {
			_ = connection.Close()
			return fmt.Errorf("send extension wrapper message: %w", err)
		}
		response, err := bufio.NewReaderSize(connection, extensionNativeMessageLimit).ReadBytes('\n')
		_ = connection.Close()
		if err != nil {
			return fmt.Errorf("read extension wrapper response: %w", err)
		}
		response = response[:len(response)-1]
		if len(response) == 0 || len(response) > extensionNativeMessageLimit {
			return fmt.Errorf("invalid extension wrapper response size %d", len(response))
		}
		if err := binary.Write(os.Stdout, binary.LittleEndian, uint32(len(response))); err != nil {
			return fmt.Errorf("write native response size: %w", err)
		}
		if _, err := os.Stdout.Write(response); err != nil {
			return fmt.Errorf("write native response: %w", err)
		}
	}
}
