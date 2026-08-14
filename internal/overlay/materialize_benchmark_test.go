package overlay

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkMaterialize exercises a flat profile with both changed and upper-only
// entries so lower/upper name matching remains visible in the measurement.
func BenchmarkMaterialize(b *testing.B) {
	const (
		lowerFileCount = 2048
		upperOverlap   = lowerFileCount / 2
		upperOnly      = lowerFileCount / 2
	)

	root := b.TempDir()
	lower := filepath.Join(root, "lower")
	upper := filepath.Join(root, "upper")
	dest := filepath.Join(root, "dest")
	if err := os.MkdirAll(lower, 0o755); err != nil {
		b.Fatal(err)
	}
	if err := os.MkdirAll(upper, 0o755); err != nil {
		b.Fatal(err)
	}

	payload := []byte("benchmark profile entry")
	for i := 0; i < lowerFileCount; i++ {
		name := filepath.Join(lower, fmt.Sprintf("lower-%04d.txt", i))
		if err := os.WriteFile(name, payload, 0o644); err != nil {
			b.Fatal(err)
		}
	}
	for i := 0; i < upperOverlap; i++ {
		name := filepath.Join(upper, fmt.Sprintf("lower-%04d.txt", i))
		if err := os.WriteFile(name, payload, 0o644); err != nil {
			b.Fatal(err)
		}
	}
	for i := 0; i < upperOnly; i++ {
		name := filepath.Join(upper, fmt.Sprintf("upper-%04d.txt", i))
		if err := os.WriteFile(name, payload, 0o644); err != nil {
			b.Fatal(err)
		}
	}

	input := MaterializeInput{LowerDir: lower, UpperDir: upper, DestDir: dest}
	if err := Materialize(context.Background(), input); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := Materialize(context.Background(), input); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(lowerFileCount+upperOnly), "files/op")
}
