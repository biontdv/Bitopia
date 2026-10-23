package agent

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// ptyRunner launches a real CLI under a pseudo-terminal and streams its combined
// output. It implements the runner interface consumed by the lifecycle Manager.
//
// Pause/Resume use SIGSTOP/SIGCONT on the process group; Stop sends SIGTERM then
// SIGKILL after a grace period.
type ptyRunner struct {
	argv    []string
	env     []string
	workDir string

	cmd    *exec.Cmd
	master *os.File
	slave  *os.File

	out  chan OutputChunk
	done chan struct{}

	mu   sync.Mutex
	pid  int
	exit error
}

// newPTYRunner constructs a PTY runner for the given command.
func newPTYRunner(argv, env []string, workDir string) *ptyRunner {
	return &ptyRunner{
		argv:    argv,
		env:     env,
		workDir: workDir,
		out:     make(chan OutputChunk, 64),
		done:    make(chan struct{}),
	}
}

// Output returns the channel of process output chunks.
func (p *ptyRunner) Output() <-chan OutputChunk { return p.out }

// Wait blocks until the process has exited and output drained.
func (p *ptyRunner) Wait() { <-p.done }

// ExitError returns the error captured from cmd.Wait(): nil if the process
// exited with status zero, or a non-nil error (e.g. *exec.ExitError) otherwise.
// It is only meaningful after Wait has returned.
func (p *ptyRunner) ExitError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exit
}

// Start opens the PTY, launches the process, and begins reading its output.
func (p *ptyRunner) Start() error {
	if !ptySupported() {
		return errPTYUnsupportedForRunner()
	}
	if len(p.argv) == 0 {
		return fmt.Errorf("pty: empty argv")
	}

	master, slave, err := openPTY()
	if err != nil {
		return err
	}
	p.master = master
	p.slave = slave

	cmd := exec.Command(p.argv[0], p.argv[1:]...)
	if len(p.env) > 0 {
		cmd.Env = append(os.Environ(), p.env...)
	}
	if p.workDir != "" {
		cmd.Dir = p.workDir
	}
	configureCmdForPTY(cmd, slave)
	p.cmd = cmd

	if err := cmd.Start(); err != nil {
		master.Close()
		slave.Close()
		return fmt.Errorf("pty: start %q: %w", p.argv[0], err)
	}

	// The slave is now owned by the child; close our copy so EOF propagates on
	// the master when the child exits.
	slave.Close()
	p.slave = nil

	p.mu.Lock()
	p.pid = cmd.Process.Pid
	p.mu.Unlock()

	go p.readLoop()
	go p.waitLoop()
	return nil
}

func (p *ptyRunner) readLoop() {
	buf := make([]byte, 4096)
	for {
		n, err := p.master.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			select {
			case p.out <- OutputChunk{Stream: "stdout", Data: string(data)}:
			case <-time.After(time.Second):
			}
		}
		if err != nil {
			close(p.out)
			return
		}
	}
}

func (p *ptyRunner) waitLoop() {
	err := p.cmd.Wait()
	p.mu.Lock()
	p.exit = err
	p.mu.Unlock()
	if p.master != nil {
		p.master.Close()
	}
	close(p.done)
}

// Pause suspends the process group with SIGSTOP.
func (p *ptyRunner) Pause() error { return p.signalGroup(syscall.SIGSTOP) }

// Resume continues the process group with SIGCONT.
func (p *ptyRunner) Resume() error { return p.signalGroup(syscall.SIGCONT) }

// Stop sends SIGTERM, then SIGKILL after the grace period if still alive.
func (p *ptyRunner) Stop(grace time.Duration) error {
	if err := p.signalGroup(syscall.SIGTERM); err != nil {
		return err
	}
	select {
	case <-p.done:
		return nil
	case <-time.After(grace):
		return p.signalGroup(syscall.SIGKILL)
	}
}

// Signal sends a named signal to the process group.
func (p *ptyRunner) Signal(name string) error {
	switch name {
	case "SIGSTOP":
		return p.signalGroup(syscall.SIGSTOP)
	case "SIGCONT":
		return p.signalGroup(syscall.SIGCONT)
	case "SIGTERM":
		return p.signalGroup(syscall.SIGTERM)
	case "SIGKILL":
		return p.signalGroup(syscall.SIGKILL)
	default:
		return fmt.Errorf("pty: unknown signal %q", name)
	}
}

// PID returns the process id, or 0 if not started.
func (p *ptyRunner) PID() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pid
}

// signalGroup delivers sig to the child's process group (negative pid). Because
// the child is a session leader (Setsid), its pid is also its process-group id.
func (p *ptyRunner) signalGroup(sig syscall.Signal) error {
	p.mu.Lock()
	pid := p.pid
	p.mu.Unlock()
	if pid == 0 {
		return fmt.Errorf("pty: process not started")
	}
	if err := syscall.Kill(-pid, sig); err != nil {
		// Fall back to the single process if the group signal fails.
		return syscall.Kill(pid, sig)
	}
	return nil
}

func errPTYUnsupportedForRunner() error {
	return fmt.Errorf("pty: not supported on this platform")
}
