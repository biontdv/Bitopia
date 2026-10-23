//go:build !linux

package agent

import (
	"errors"
	"os"
	"os/exec"
)

// errPTYUnsupported is returned by the PTY primitive on non-Linux platforms so
// the module still compiles cross-platform. PTY-backed adapters are only
// supported on Linux in this build.
var errPTYUnsupported = errors.New("pty: pseudo-terminals are only supported on linux in this build")

// openPTY is unsupported on non-Linux platforms.
func openPTY() (master *os.File, slave *os.File, err error) {
	return nil, nil, errPTYUnsupported
}

// configureCmdForPTY is a no-op stub on non-Linux platforms.
func configureCmdForPTY(_ *exec.Cmd, _ *os.File) {}

// ptySupported reports whether PTY launching is available on this platform.
func ptySupported() bool { return false }
