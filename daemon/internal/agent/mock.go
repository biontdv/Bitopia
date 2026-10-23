package agent

import (
	"fmt"
	"sync"
	"time"
)

// mockRunner is the synthetic output generator used by the MOCK adapter. It
// writes timestamped fake TUI/log lines to an output channel a few times per
// second, including a periodic fake "progress" line. It supports pause/resume
// (halting and resuming the ticking) and stop (closing the output channel).
//
// mockRunner implements the runner interface consumed by the lifecycle Manager.
type mockRunner struct {
	displayName string
	interval    time.Duration

	out  chan OutputChunk
	done chan struct{}

	mu      sync.Mutex
	paused  bool
	resumed chan struct{} // signaled when unpaused so the loop can proceed
	stopped bool
	line    int
}

// newMockRunner constructs a mock runner for the given display name.
func newMockRunner(displayName string) *mockRunner {
	return &mockRunner{
		displayName: displayName,
		interval:    250 * time.Millisecond,
		out:         make(chan OutputChunk, 64),
		done:        make(chan struct{}),
		resumed:     make(chan struct{}),
	}
}

// Output returns the channel of synthetic output chunks.
func (m *mockRunner) Output() <-chan OutputChunk { return m.out }

// Wait blocks until the runner has fully stopped (done closed).
func (m *mockRunner) Wait() { <-m.done }

// ExitError reports the exit status of the mock runner. The mock only ends on
// an explicit Stop, which is a clean shutdown, so it always reports nil.
func (m *mockRunner) ExitError() error { return nil }

// Start begins generating output. It returns immediately; generation runs in a
// goroutine until Stop is called.
func (m *mockRunner) Start() error {
	go m.loop()
	return nil
}

// Pause halts output generation. Already-buffered chunks remain; no new chunks
// are produced until Resume. Returns an error if the runner is stopped.
func (m *mockRunner) Pause() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped {
		return fmt.Errorf("mock: already stopped")
	}
	m.paused = true
	return nil
}

// Resume restarts output generation after a Pause.
func (m *mockRunner) Resume() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped {
		return fmt.Errorf("mock: already stopped")
	}
	if !m.paused {
		return nil
	}
	m.paused = false
	// Wake the loop if it is blocked waiting to resume.
	select {
	case m.resumed <- struct{}{}:
	default:
	}
	return nil
}

// Stop permanently ends generation and closes the output channel.
func (m *mockRunner) Stop(_ time.Duration) error {
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return nil
	}
	m.stopped = true
	m.paused = false
	m.mu.Unlock()
	// Wake a possibly-paused loop so it observes the stop.
	select {
	case m.resumed <- struct{}{}:
	default:
	}
	return nil
}

// Signal is a no-op for the mock runner (no OS process). It exists to satisfy
// the runner interface.
func (m *mockRunner) Signal(_ string) error { return nil }

// PID returns 0; the mock runner has no OS process.
func (m *mockRunner) PID() int { return 0 }

func (m *mockRunner) loop() {
	defer close(m.out)
	defer close(m.done)

	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	for {
		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		paused := m.paused
		m.mu.Unlock()

		if paused {
			// Block until resumed or stopped.
			<-m.resumed
			continue
		}

		select {
		case <-ticker.C:
			m.emit()
		case <-m.resumed:
			// Spurious wake (resume while already running); loop again.
		}
	}
}

// emit produces one synthetic output chunk, periodically a "progress" line.
func (m *mockRunner) emit() {
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return
	}
	m.line++
	n := m.line
	m.mu.Unlock()

	ts := time.Now().Format("15:04:05")
	var data string
	if n%4 == 0 {
		pct := (n * 7) % 100
		data = fmt.Sprintf("[%s] %s progress: compiling module %d/20 (%d%%)\n", ts, m.displayName, (n%20)+1, pct)
	} else {
		data = fmt.Sprintf("[%s] %s log line %d: working...\n", ts, m.displayName, n)
	}

	chunk := OutputChunk{Stream: "stdout", Data: data}
	select {
	case m.out <- chunk:
	case <-time.After(time.Second):
		// Drop if nobody is draining for a while; protects the generator.
	}
}
