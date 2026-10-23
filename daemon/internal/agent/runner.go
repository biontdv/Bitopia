package agent

import "time"

// OutputChunk is one piece of agent output forwarded to the hub.
type OutputChunk struct {
	Stream string // "stdout" or "stderr"
	Data   string // raw UTF-8, may contain ANSI escapes
}

// runner abstracts a running agent process (real PTY process or the synthetic
// mock generator). The lifecycle Manager drives runners uniformly.
type runner interface {
	// Start begins execution and output production.
	Start() error
	// Output returns the channel of output chunks; closed when the runner ends.
	Output() <-chan OutputChunk
	// Wait blocks until the runner has fully exited.
	Wait()
	// Pause suspends output/execution (SIGSTOP for PTY, halt generator for mock).
	Pause() error
	// Resume continues after a Pause.
	Resume() error
	// Stop terminates the runner, allowing up to grace before a hard kill.
	Stop(grace time.Duration) error
	// Signal sends a named OS signal (no-op for the mock runner).
	Signal(name string) error
	// PID returns the OS process id, or 0 when there is none.
	PID() int
}
