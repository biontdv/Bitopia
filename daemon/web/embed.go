// Package web embeds the compiled browser UI into the daemon binary via
// //go:embed. In the offline sandbox this holds a committed placeholder
// (dist/index.html); FEAT-003 compiles the dependency-free fallback UI into
// dist/, and the production React/Pixi build replaces it on a networked machine.
package web

import (
	"embed"
	"io/fs"
)

// The embedded dist/ is compiled output of frontend-fallback/src. Regenerate it
// (and keep it from drifting) by running the fallback build, which recompiles
// with the global tsc and copies the static assets into this dir:
//
//go:generate ../../frontend-fallback/build.sh
//
//go:embed all:dist
var distFS embed.FS

// FS returns the embedded UI file system rooted at dist/.
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
