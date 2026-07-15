package web

import (
	"embed"
	"io/fs"
)

// EmbedRoot is the stable production build output path relative to web/.
const EmbedRoot = "dist/client"

//go:embed dist/client/index.html
var requiredIndexHTML []byte

//go:embed all:dist/client
var embedded embed.FS

// StaticAssets returns the embedded SPA filesystem with index.html at the root.
// Run `pnpm build` in web/ before building Go; the build fails if assets are missing.
func StaticAssets() fs.FS {
	_ = requiredIndexHTML
	root, err := fs.Sub(embedded, EmbedRoot)
	if err != nil {
		panic("web: embedded static assets unavailable: " + err.Error())
	}
	return root
}
