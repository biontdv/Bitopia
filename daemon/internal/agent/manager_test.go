package agent

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/agentic-office/daemon/internal/ws"
)

// captureHub records broadcast envelopes for assertions.
type captureHub struct {
	mu   sync.Mutex
	envs []ws.Envelope
}

func (h *captureHub) Broadcast(env ws.Envelope) {
	h.mu.Lock()
	h.envs = append(h.envs, env)
	h.mu.Unlock()
}

func (h *captureHub) outputCount(agentID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.envs {
		if e.Type == "agent.output" && e.AgentID == agentID {
			n++
		}
	}
	return n
}

func (h *captureHub) states(agentID string) []StatePayload {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []StatePayload
	for _, e := range h.envs {
		if e.Type == "agent.state" && e.AgentID == agentID {
			var p StatePayload
			if err := json.Unmarshal(e.Payload, &p); err == nil {
				out = append(out, p)
			}
		}
	}
	return out
}

func newTestManager() (*Manager, *captureHub) {
	h := &captureHub{}
	m := NewManager(h)
	return m, h
}

// waitFor polls until cond is true or the timeout elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

// TestMockStartProducesOutput asserts a started mock agent actually streams
// output. Fails if the generator or reader goroutine were removed.
func TestMockStartProducesOutput(t *testing.T) {
	m, h := newTestManager()
	m.Add(AgentConfig{ID: "a1", DisplayName: "Mock 1", Adapter: KindMock})

	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !waitFor(t, 3*time.Second, func() bool { return h.outputCount("a1") >= 2 }) {
		t.Fatalf("expected output to flow, got %d chunks", h.outputCount("a1"))
	}
	if st, _ := m.State("a1"); st != StateRunning {
		t.Fatalf("state = %q, want running", st)
	}
	_ = m.Stop("a1", 200*time.Millisecond)
}

// TestPauseHaltsResumeRestarts asserts pause stops the output flow and resume
// restarts it. Fails if pause/resume were no-ops.
func TestPauseHaltsResumeRestarts(t *testing.T) {
	m, h := newTestManager()
	m.Add(AgentConfig{ID: "a1", DisplayName: "Mock 1", Adapter: KindMock})
	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !waitFor(t, 3*time.Second, func() bool { return h.outputCount("a1") >= 1 }) {
		t.Fatalf("expected initial output")
	}

	if err := m.Pause("a1"); err != nil {
		t.Fatalf("Pause: %v", err)
	}
	if st, _ := m.State("a1"); st != StatePaused {
		t.Fatalf("state = %q, want paused", st)
	}
	// Let any buffered chunks drain, then confirm the count is stable.
	time.Sleep(600 * time.Millisecond)
	before := h.outputCount("a1")
	time.Sleep(600 * time.Millisecond)
	after := h.outputCount("a1")
	if after != before {
		t.Fatalf("output kept flowing while paused: before=%d after=%d", before, after)
	}

	if err := m.Resume("a1"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !waitFor(t, 3*time.Second, func() bool { return h.outputCount("a1") > after }) {
		t.Fatalf("output did not restart after resume (still %d)", h.outputCount("a1"))
	}
	_ = m.Stop("a1", 200*time.Millisecond)
}

// TestStopTransitionsToStopped asserts a stop drives the agent to stopped.
func TestStopTransitionsToStopped(t *testing.T) {
	m, _ := newTestManager()
	m.Add(AgentConfig{ID: "a1", DisplayName: "Mock 1", Adapter: KindMock})
	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitFor(t, time.Second, func() bool { st, _ := m.State("a1"); return st == StateRunning })

	if err := m.Stop("a1", 200*time.Millisecond); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !waitFor(t, 3*time.Second, func() bool { st, _ := m.State("a1"); return st == StateStopped }) {
		st, _ := m.State("a1")
		t.Fatalf("state = %q, want stopped", st)
	}
}

// TestStopAllStopsMultiple asserts StopAll stops every running agent.
func TestStopAllStopsMultiple(t *testing.T) {
	m, _ := newTestManager()
	ids := []string{"a1", "a2", "a3"}
	for _, id := range ids {
		m.Add(AgentConfig{ID: id, DisplayName: id, Adapter: KindMock})
		if err := m.Start(id, ""); err != nil {
			t.Fatalf("Start %s: %v", id, err)
		}
	}
	for _, id := range ids {
		waitFor(t, time.Second, func() bool { st, _ := m.State(id); return st == StateRunning })
	}

	m.StopAll()

	for _, id := range ids {
		if !waitFor(t, 3*time.Second, func() bool { st, _ := m.State(id); return st == StateStopped }) {
			st, _ := m.State(id)
			t.Fatalf("agent %s state = %q, want stopped", id, st)
		}
	}
}

// TestWhipEmitsGagWithoutChangingState asserts the whip gag emits a one-shot
// whipped=true state followed by whipped=false, and never changes the run state.
func TestWhipEmitsGagWithoutChangingState(t *testing.T) {
	m, h := newTestManager()
	m.Add(AgentConfig{ID: "a1", DisplayName: "Mock 1", Adapter: KindMock})
	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitFor(t, time.Second, func() bool { st, _ := m.State("a1"); return st == StateRunning })

	stateBefore, _ := m.State("a1")
	if err := m.Whip("a1"); err != nil {
		t.Fatalf("Whip: %v", err)
	}

	states := h.states("a1")
	// Find a whipped=true followed by whipped=false.
	sawWhipTrue := false
	sawWhipFalseAfter := false
	for _, s := range states {
		if s.Whipped {
			sawWhipTrue = true
			continue
		}
		if sawWhipTrue && !s.Whipped {
			sawWhipFalseAfter = true
		}
	}
	if !sawWhipTrue {
		t.Fatalf("expected a whipped=true state event")
	}
	if !sawWhipFalseAfter {
		t.Fatalf("expected a whipped=false state after the gag")
	}

	stateAfter, _ := m.State("a1")
	if stateAfter != stateBefore {
		t.Fatalf("whip changed run state: before=%q after=%q", stateBefore, stateAfter)
	}
	if stateAfter != StateRunning {
		t.Fatalf("agent should still be running after whip, got %q", stateAfter)
	}
	_ = m.Stop("a1", 200*time.Millisecond)
}

// crashRunner is a runner that exits immediately with a failing status, used to
// exercise the crash-loop breaker.
type crashRunner struct {
	out  chan OutputChunk
	done chan struct{}
}

func newCrashRunner() *crashRunner {
	return &crashRunner{out: make(chan OutputChunk), done: make(chan struct{})}
}

func (c *crashRunner) Start() error {
	// Exit almost immediately (quick exit => counts toward the breaker).
	go func() {
		close(c.out)
		close(c.done)
	}()
	return nil
}
func (c *crashRunner) Output() <-chan OutputChunk { return c.out }
func (c *crashRunner) Wait()                      { <-c.done }

// ExitError reports a non-nil failing exit so the exit is treated as a crash.
func (c *crashRunner) ExitError() error         { return fmt.Errorf("exit status 1") }
func (c *crashRunner) Pause() error             { return nil }
func (c *crashRunner) Resume() error            { return nil }
func (c *crashRunner) Stop(time.Duration) error { return nil }
func (c *crashRunner) Signal(string) error      { return nil }
func (c *crashRunner) PID() int                 { return 0 }

// cleanExitRunner runs past the crash window and then exits with a zero status
// (ExitError == nil), modeling a real CLI that completes its task normally.
type cleanExitRunner struct {
	delay   time.Duration
	out     chan OutputChunk
	done    chan struct{}
	starts  *int32Counter
	stopped chan struct{}
}

func newCleanExitRunner(delay time.Duration, starts *int32Counter) *cleanExitRunner {
	return &cleanExitRunner{
		delay:   delay,
		out:     make(chan OutputChunk),
		done:    make(chan struct{}),
		starts:  starts,
		stopped: make(chan struct{}),
	}
}

func (c *cleanExitRunner) Start() error {
	c.starts.inc()
	go func() {
		select {
		case <-time.After(c.delay):
			// Ran to completion successfully.
		case <-c.stopped:
			// Stopped early by the manager.
		}
		close(c.out)
		close(c.done)
	}()
	return nil
}
func (c *cleanExitRunner) Output() <-chan OutputChunk { return c.out }
func (c *cleanExitRunner) Wait()                      { <-c.done }

// ExitError is nil: a clean, successful exit.
func (c *cleanExitRunner) ExitError() error { return nil }
func (c *cleanExitRunner) Pause() error     { return nil }
func (c *cleanExitRunner) Resume() error    { return nil }
func (c *cleanExitRunner) Stop(time.Duration) error {
	select {
	case <-c.stopped:
	default:
		close(c.stopped)
	}
	return nil
}
func (c *cleanExitRunner) Signal(string) error { return nil }
func (c *cleanExitRunner) PID() int            { return 0 }

// int32Counter is a tiny mutex-guarded counter used to count runner launches.
type int32Counter struct {
	mu sync.Mutex
	n  int
}

func (c *int32Counter) inc() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}

func (c *int32Counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// TestCrashLoopTripsBreaker asserts that repeated immediate exits trip the
// circuit breaker and move the agent to crashed rather than restarting forever.
func TestCrashLoopTripsBreaker(t *testing.T) {
	m, _ := newTestManager()
	// Tighten the breaker so the test is fast and deterministic.
	m.crashWindow = time.Second
	m.crashThreshold = 3
	m.setFactory(func(cfg AgentConfig) (runner, string, error) {
		return newCrashRunner(), "mock", nil
	})

	m.Add(AgentConfig{ID: "a1", DisplayName: "Crasher", Adapter: KindMock})
	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if !waitFor(t, 5*time.Second, func() bool { st, _ := m.State("a1"); return st == StateCrashed }) {
		st, _ := m.State("a1")
		t.Fatalf("breaker did not trip; state = %q", st)
	}
	if r, _ := m.Restarts("a1"); r < m.crashThreshold {
		t.Fatalf("expected at least %d restarts recorded, got %d", m.crashThreshold, r)
	}
}

// TestCleanExitAfterWindowSettlesStopped asserts a runner that exits cleanly
// AFTER the crash window transitions the agent to stopped and is NOT relaunched.
// This is the exact gap the earlier suite missed: a real CLI that completes its
// task with exit code 0 must settle, not respawn forever. It also asserts that
// Start can restart the stopped agent.
func TestCleanExitAfterWindowSettlesStopped(t *testing.T) {
	m, _ := newTestManager()
	// Short crash window so the runner's delay easily exceeds it.
	m.crashWindow = 50 * time.Millisecond

	starts := &int32Counter{}
	m.setFactory(func(cfg AgentConfig) (runner, string, error) {
		return newCleanExitRunner(150*time.Millisecond, starts), "mock", nil
	})

	m.Add(AgentConfig{ID: "a1", DisplayName: "Finisher", Adapter: KindMock})
	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// The runner exits cleanly after ~150ms; the agent must settle to stopped.
	if !waitFor(t, 3*time.Second, func() bool { st, _ := m.State("a1"); return st == StateStopped }) {
		st, _ := m.State("a1")
		t.Fatalf("clean exit did not settle to stopped; state = %q", st)
	}

	// It must NOT be relaunched: exactly one start, and the state stays stopped.
	time.Sleep(300 * time.Millisecond)
	if n := starts.get(); n != 1 {
		t.Fatalf("clean-exit agent was relaunched: launches = %d, want 1", n)
	}
	if st, _ := m.State("a1"); st != StateStopped {
		t.Fatalf("agent should remain stopped, got %q", st)
	}
	if r, _ := m.Restarts("a1"); r != 0 {
		t.Fatalf("clean exit should not record restarts, got %d", r)
	}

	// A stopped agent can still be restarted by an explicit Start.
	if err := m.Start("a1", ""); err != nil {
		t.Fatalf("restart of stopped agent: %v", err)
	}
	if !waitFor(t, time.Second, func() bool { st, _ := m.State("a1"); return st == StateRunning }) {
		st, _ := m.State("a1")
		t.Fatalf("restarted agent did not reach running; state = %q", st)
	}
	if n := starts.get(); n != 2 {
		t.Fatalf("expected a second launch after restart, got %d", n)
	}
	_ = m.Stop("a1", 200*time.Millisecond)
}

// TestInvalidTransitionRejected asserts pausing a never-started agent is
// rejected with the invalid-transition error.
func TestInvalidTransitionRejected(t *testing.T) {
	m, _ := newTestManager()
	m.Add(AgentConfig{ID: "a1", DisplayName: "Idle", Adapter: KindMock})
	if err := m.Pause("a1"); err == nil {
		t.Fatalf("expected invalid transition error pausing an idle agent")
	}
}

// TestPTYAdapterBuildsConfigDrivenArgv asserts PTY adapters build a
// config-driven argv without requiring the CLI to exist at build time.
func TestPTYAdapterBuildsConfigDrivenArgv(t *testing.T) {
	for _, kind := range []string{KindClaude, KindCodex, KindAntigravity} {
		ad, err := NewAdapter(kind, AdapterConfig{ID: "x"})
		if err != nil {
			t.Fatalf("NewAdapter(%s): %v", kind, err)
		}
		if !ad.SupportsPTY() {
			t.Fatalf("%s adapter should support PTY", kind)
		}
		argv, _, err := ad.BuildCommand(AdapterConfig{ID: "x"})
		if err != nil {
			t.Fatalf("BuildCommand(%s): %v", kind, err)
		}
		if len(argv) == 0 || argv[0] != kind {
			t.Fatalf("%s argv default = %v, want [%s ...]", kind, argv, kind)
		}

		// Config-driven override.
		argv2, _, err := ad.BuildCommand(AdapterConfig{ID: "x", Argv: []string{"custom", "--flag"}})
		if err != nil {
			t.Fatalf("BuildCommand override(%s): %v", kind, err)
		}
		if len(argv2) != 2 || argv2[0] != "custom" || argv2[1] != "--flag" {
			t.Fatalf("%s override argv = %v", kind, argv2)
		}
	}

	// Default/unknown => mock, no PTY.
	md, _ := NewAdapter("", AdapterConfig{ID: "x"})
	if md.Name() != KindMock || md.SupportsPTY() {
		t.Fatalf("empty kind should default to mock without PTY, got %q pty=%v", md.Name(), md.SupportsPTY())
	}
}
