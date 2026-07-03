package cli

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func findCommand(root *cobra.Command, path string) *cobra.Command {
	parts := strings.Split(path, " ")
	current := root
	for _, part := range parts {
		var next *cobra.Command
		for _, child := range current.Commands() {
			if child.Name() == part {
				next = child
				break
			}
		}
		if next == nil {
			return nil
		}
		current = next
	}
	return current
}

func TestRootCommandSurface(t *testing.T) {
	cmd := newRootCmd()

	required := []string{
		"serve",
		"migrate",
		"admin bootstrap",
		"admin tenants create",
		"admin tenants list",
		"admin tenants update",
		"admin tenants delete",
		"admin tenants restore",
		"admin tokens create",
		"admin tokens revoke",
		"trigger gc",
	}

	for _, path := range required {
		if findCommand(cmd, path) == nil {
			t.Fatalf("missing command %q", path)
		}
	}
}
