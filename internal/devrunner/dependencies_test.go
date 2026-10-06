package devrunner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContainerDependenciesMaskEveryWorkspace(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"apps/web", "packages/ui", "extensions/enforcer"} {
		dir := filepath.Join(root, path)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{}`), 0644); err != nil {
			t.Fatal(err)
		}
	}
	args, err := containerDependencyVolumes(root, "aperture-test")
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 8 {
		t.Fatalf("volume arguments %v", args)
	}
	for _, path := range []string{"node_modules", "apps/web/node_modules", "packages/ui/node_modules", "extensions/enforcer/node_modules"} {
		found := false
		for _, arg := range args {
			if strings.HasSuffix(arg, ":/workspace/"+path+":nocopy") {
				found = true
			}
		}
		if !found {
			t.Errorf("host dependencies at %s are not masked", path)
		}
	}
}
