//go:build linux

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// openPTY opens a new pseudo-terminal master/slave pair using only the Go
// standard library (no creack/pty). It returns the master *os.File (read/write
// by the reader goroutine) and the slave *os.File (handed to the child process
// as stdin/stdout/stderr). This was verified working on the sandbox kernel.
//
// Steps:
//  1. open /dev/ptmx to get the master,
//  2. ioctl(TIOCSPTLCK, 0) to unlock the slave,
//  3. ioctl(TIOCGPTN) to get the slave number and derive /dev/pts/N,
//  4. open the slave.
func openPTY() (master *os.File, slave *os.File, err error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("pty: open /dev/ptmx: %w", err)
	}

	// Unlock the slave: TIOCSPTLCK expects a pointer to an int set to 0.
	var unlock int = 0
	if err := ioctl(m.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); err != nil {
		m.Close()
		return nil, nil, fmt.Errorf("pty: TIOCSPTLCK: %w", err)
	}

	// Get the pty number: TIOCGPTN writes the slave index to an unsigned int.
	var ptn uint32
	if err := ioctl(m.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&ptn))); err != nil {
		m.Close()
		return nil, nil, fmt.Errorf("pty: TIOCGPTN: %w", err)
	}

	slavePath := fmt.Sprintf("/dev/pts/%d", ptn)
	s, err := os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		m.Close()
		return nil, nil, fmt.Errorf("pty: open %s: %w", slavePath, err)
	}

	return m, s, nil
}

// ioctl is a thin wrapper over SYS_IOCTL that returns a Go error.
func ioctl(fd, request, arg uintptr) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, arg)
	if errno != 0 {
		return errno
	}
	return nil
}

// ptyAttr returns the SysProcAttr that makes the child a session leader with a
// controlling terminal on the slave PTY.
func ptyAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
	}
}

// configureCmdForPTY wires the command's stdio to the slave and sets the
// session/controlling-tty attributes. It is called by the pty runner before
// starting the process.
func configureCmdForPTY(cmd *exec.Cmd, slave *os.File) {
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = ptyAttr()
}

// ptySupported reports whether PTY launching is available on this platform.
func ptySupported() bool { return true }
