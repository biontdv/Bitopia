package agent

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/agentic-office/daemon/internal/ws"
)

// Broadcaster is the subset of the ws.Hub the Manager needs. The Manager uses
// it to broadcast agent.state / agent.output / agent.list envelopes.
type Broadcaster interface {
	Broadcast(env ws.Envelope)
}

// AgentConfig is the per-agent configuration the Manager stores.
type AgentConfig struct {
	ID          string
	DisplayName string
	Adapter     string // kind: mock | claude | codex | antigravity
	Argv        []string
	Env         map[string]string
	WorkDir     string
}

// runnerFactory builds a runner for an agent. It is injectable so tests can
// provide deterministic runners (including ones that crash immediately).
type runnerFactory func(cfg AgentConfig) (runner, string, error)

// defaultRunnerFactory selects the adapter by kind and builds the matching
// runner (mock generator or PTY process).
func defaultRunnerFactory(cfg AgentConfig) (runner, string, error) {
	adapter, err := NewAdapter(cfg.Adapter, AdapterConfig{
		ID:          cfg.ID,
		DisplayName: cfg.DisplayName,
		Argv:        cfg.Argv,
		Env:         cfg.Env,
		WorkDir:     cfg.WorkDir,
	})
	if err != nil {
		return nil, "", err
	}

	if !adapter.SupportsPTY() {
		return newMockRunner(cfg.DisplayName), adapter.Name(), nil
	}

	argv, env, err := adapter.BuildCommand(AdapterConfig{
		ID:          cfg.ID,
		DisplayName: cfg.DisplayName,
		Argv:        cfg.Argv,
		Env:         cfg.Env,
		WorkDir:     cfg.WorkDir,
	})
	if err != nil {
		return nil, "", err
	}
	return newPTYRunner(argv, env, cfg.WorkDir), adapter.Name(), nil
}

// Circuit-breaker tuning: if an agent exits unexpectedly crashWindow after
// starting, that counts as a crash; crashThreshold such crashes in a row trips
// the breaker and moves the agent to crashed instead of restarting.
const (
	defaultCrashWindow    = 2 * time.Second
	defaultCrashThreshold = 3
	defaultStopGrace      = 3 * time.Second
)

// Agent is one supervised agent and its state machine.
type Agent struct {
	cfg AgentConfig

	mu       sync.Mutex
	state    State
	adapter  string
	pid      int
	restarts int

	run    runner
	cancel chan struct{} // closed to tell the monitor a stop was requested
	gen    uint64        // increments each start to ignore stale monitor events
}

// Manager owns all agents, drives transitions, and broadcasts envelopes. All
// state transitions funnel through Manager methods so they are serialized.
type Manager struct {
	mu     sync.Mutex
	agents map[string]*Agent
	order  []string

	hub     Broadcaster
	factory runnerFactory

	crashWindow    time.Duration
	crashThreshold int
	stopGrace      time.Duration
}

// NewManager creates a Manager that broadcasts via hub.
func NewManager(hub Broadcaster) *Manager {
	return &Manager{
		agents:         make(map[string]*Agent),
		hub:            hub,
		factory:        defaultRunnerFactory,
		crashWindow:    defaultCrashWindow,
		crashThreshold: defaultCrashThreshold,
		stopGrace:      defaultStopGrace,
	}
}

// setFactory overrides the runner factory (tests only).
func (m *Manager) setFactory(f runnerFactory) { m.factory = f }

// Add registers an agent configuration in the idle state.
func (m *Manager) Add(cfg AgentConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.agents[cfg.ID]; ok {
		return
	}
	m.agents[cfg.ID] = &Agent{
		cfg:     cfg,
		state:   StateIdle,
		adapter: cfg.Adapter,
	}
	m.order = append(m.order, cfg.ID)
}

// get returns the agent by id.
func (m *Manager) get(id string) (*Agent, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.agents[id]
	return a, ok
}

// List returns a snapshot of all agents for an agent.list payload.
func (m *Manager) List() ListPayload {
	m.mu.Lock()
	ids := append([]string(nil), m.order...)
	agents := make(map[string]*Agent, len(m.agents))
	for k, v := range m.agents {
		agents[k] = v
	}
	m.mu.Unlock()

	entries := make([]ListEntry, 0, len(ids))
	for _, id := range ids {
		a := agents[id]
		a.mu.Lock()
		entries = append(entries, ListEntry{
			ID:          a.cfg.ID,
			DisplayName: a.cfg.DisplayName,
			Adapter:     a.adapter,
			State:       a.state,
		})
		a.mu.Unlock()
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	return ListPayload{Agents: entries}
}

// BroadcastList broadcasts the current roster.
func (m *Manager) BroadcastList() {
	m.hub.Broadcast(ws.MustEnvelope("agent.list", "", m.List()))
}

// broadcastState emits an agent.state envelope reflecting the agent's current
// fields. whipped is a one-shot cosmetic flag set ONLY for the cambuk gag event
// (see Whip). Consumers MUST treat an agent.state with whipped=true as a
// transient animation trigger and NOT cache its lifecycle fields: the run state
// does not change on a whip, and a normal whipped=false state is broadcast
// immediately after. Both current clients honor this (store.applyState early
// returns on whipped). This one-shot overload of agent.state is deliberate and
// documented in DESIGN.md section 2.3.
func (m *Manager) broadcastState(a *Agent, whipped bool) {
	a.mu.Lock()
	payload := StatePayload{
		State:       a.state,
		Adapter:     a.adapter,
		DisplayName: a.cfg.DisplayName,
		PID:         a.pid,
		Restarts:    a.restarts,
		Whipped:     whipped,
	}
	id := a.cfg.ID
	a.mu.Unlock()
	m.hub.Broadcast(ws.MustEnvelope("agent.state", id, payload))
}

// Start launches (or restarts) an agent. adapterOverride, if non-empty, changes
// the configured adapter kind before launching.
func (m *Manager) Start(id, adapterOverride string) error {
	a, ok := m.get(id)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}

	a.mu.Lock()
	if adapterOverride != "" {
		a.cfg.Adapter = adapterOverride
		a.adapter = adapterOverride
	}
	if !canTransition(a.state, StateStarting) {
		cur := a.state
		a.mu.Unlock()
		return fmt.Errorf("%w: cannot start an agent in state %q", ErrInvalidTransition, cur)
	}
	// An explicit start resets the crash-loop breaker.
	a.restarts = 0
	cfg := a.cfg
	a.mu.Unlock()

	return m.launch(a, cfg)
}

// launch builds a runner, moves the agent to starting then running, and spins up
// the reader + monitor goroutine pair.
func (m *Manager) launch(a *Agent, cfg AgentConfig) error {
	run, adapterName, err := m.factory(cfg)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInternal, err)
	}

	a.mu.Lock()
	a.state = StateStarting
	a.adapter = adapterName
	a.run = run
	a.cancel = make(chan struct{})
	a.gen++
	gen := a.gen
	a.mu.Unlock()
	m.broadcastState(a, false)

	if err := run.Start(); err != nil {
		a.mu.Lock()
		a.state = StateCrashed
		a.mu.Unlock()
		m.broadcastState(a, false)
		return fmt.Errorf("%w: %v", ErrInternal, err)
	}

	a.mu.Lock()
	a.pid = run.PID()
	a.state = StateRunning
	startedAt := time.Now()
	a.mu.Unlock()
	m.broadcastState(a, false)

	go m.readerLoop(a, run, gen)
	go m.monitorLoop(a, run, gen, startedAt)
	return nil
}

// readerLoop forwards runner output to the hub as agent.output envelopes with a
// per-agent incrementing seq. It exits when the output channel closes.
func (m *Manager) readerLoop(a *Agent, run runner, gen uint64) {
	for chunk := range run.Output() {
		a.mu.Lock()
		stale := a.gen != gen
		id := a.cfg.ID
		a.mu.Unlock()
		if stale {
			continue
		}
		m.hub.Broadcast(ws.MustEnvelope("agent.output", id, OutputPayload{
			Stream: chunk.Stream,
			Data:   chunk.Data,
		}))
	}
}

// monitorLoop is the single goroutine that drives post-launch transitions: it
// waits for the runner to exit (or a stop request) and applies the crash-loop
// circuit breaker.
func (m *Manager) monitorLoop(a *Agent, run runner, gen uint64, startedAt time.Time) {
	exited := make(chan struct{})
	go func() {
		run.Wait()
		close(exited)
	}()

	select {
	case <-a.cancel:
		// A stop/stopAll was requested; the stop path drives the transition to
		// stopping/stopped. Wait for the actual process exit, then settle.
		<-exited
		a.mu.Lock()
		if a.gen == gen {
			a.state = StateStopped
			a.pid = 0
		}
		settled := a.gen == gen
		a.mu.Unlock()
		if settled {
			m.broadcastState(a, false)
			m.BroadcastList()
		}
		return

	case <-exited:
		// The process exited on its own. Classify it: a clean exit settles the
		// agent to stopped; a failing exit goes through the crash-loop breaker.
		m.handleUnexpectedExit(a, run, gen, startedAt)
	}
}

// handleUnexpectedExit is invoked when a runner exits without an explicit stop.
// A clean exit (nil ExitError) is a normal self-termination and settles the
// agent to stopped. A failing exit is fed through the crash-loop breaker, which
// either restarts the agent (with backoff) or trips and moves it to crashed.
func (m *Manager) handleUnexpectedExit(a *Agent, run runner, gen uint64, startedAt time.Time) {
	exitErr := run.ExitError()

	a.mu.Lock()
	if a.gen != gen {
		a.mu.Unlock()
		return
	}
	// A process that ran to completion successfully is a terminal, expected
	// event: settle to stopped and do NOT restart. This is the running->stopped
	// FSM edge for a self-terminating CLI (e.g. a claude/codex/antigravity run
	// that finishes its task with exit code 0). The crash-loop breaker below
	// only applies to genuinely-failing exits.
	if exitErr == nil {
		a.state = StateStopped
		a.pid = 0
		a.restarts = 0
		a.mu.Unlock()
		m.broadcastState(a, false)
		m.BroadcastList()
		return
	}
	// A quick exit (within the crash window) counts toward the breaker.
	quick := time.Since(startedAt) < m.crashWindow
	if quick {
		a.restarts++
	} else {
		a.restarts = 0
	}
	restarts := a.restarts
	cfg := a.cfg
	a.pid = 0
	a.mu.Unlock()

	if !quick || restarts >= m.crashThreshold {
		a.mu.Lock()
		a.state = StateCrashed
		a.mu.Unlock()
		m.broadcastState(a, false)
		m.BroadcastList()
		return
	}

	// Backoff grows with the restart count (capped), then restart.
	backoff := time.Duration(restarts) * 50 * time.Millisecond
	if backoff > time.Second {
		backoff = time.Second
	}
	time.Sleep(backoff)

	a.mu.Lock()
	// Bail if something changed generation during the backoff.
	if a.gen != gen {
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()

	if err := m.relaunch(a, cfg, gen); err != nil {
		a.mu.Lock()
		a.state = StateCrashed
		a.mu.Unlock()
		m.broadcastState(a, false)
		m.BroadcastList()
	}
}

// relaunch restarts a crashed-but-recoverable agent, preserving the restart
// counter so repeated quick exits eventually trip the breaker.
func (m *Manager) relaunch(a *Agent, cfg AgentConfig, _ uint64) error {
	run, adapterName, err := m.factory(cfg)
	if err != nil {
		return err
	}

	a.mu.Lock()
	a.state = StateStarting
	a.adapter = adapterName
	a.run = run
	a.cancel = make(chan struct{})
	a.gen++
	newGen := a.gen
	a.mu.Unlock()
	m.broadcastState(a, false)

	if err := run.Start(); err != nil {
		return err
	}

	a.mu.Lock()
	a.pid = run.PID()
	a.state = StateRunning
	startedAt := time.Now()
	a.mu.Unlock()
	m.broadcastState(a, false)

	go m.readerLoop(a, run, newGen)
	go m.monitorLoop(a, run, newGen, startedAt)
	return nil
}

// Pause suspends a running agent.
func (m *Manager) Pause(id string) error {
	a, ok := m.get(id)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	a.mu.Lock()
	if !canTransition(a.state, StatePaused) {
		cur := a.state
		a.mu.Unlock()
		return fmt.Errorf("%w: cannot pause an agent in state %q", ErrInvalidTransition, cur)
	}
	run := a.run
	a.state = StatePaused
	a.mu.Unlock()

	if run != nil {
		if err := run.Pause(); err != nil {
			return fmt.Errorf("%w: %v", ErrInternal, err)
		}
	}
	m.broadcastState(a, false)
	m.BroadcastList()
	return nil
}

// Resume continues a paused agent.
func (m *Manager) Resume(id string) error {
	a, ok := m.get(id)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	a.mu.Lock()
	if !canTransition(a.state, StateRunning) {
		cur := a.state
		a.mu.Unlock()
		return fmt.Errorf("%w: cannot resume an agent in state %q", ErrInvalidTransition, cur)
	}
	run := a.run
	a.state = StateRunning
	a.mu.Unlock()

	if run != nil {
		if err := run.Resume(); err != nil {
			return fmt.Errorf("%w: %v", ErrInternal, err)
		}
	}
	m.broadcastState(a, false)
	m.BroadcastList()
	return nil
}

// Stop terminates a single agent (SIGTERM then SIGKILL after grace).
func (m *Manager) Stop(id string, grace time.Duration) error {
	a, ok := m.get(id)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	return m.stopAgent(a, grace)
}

func (m *Manager) stopAgent(a *Agent, grace time.Duration) error {
	a.mu.Lock()
	if !canTransition(a.state, StateStopping) {
		cur := a.state
		a.mu.Unlock()
		return fmt.Errorf("%w: cannot stop an agent in state %q", ErrInvalidTransition, cur)
	}
	run := a.run
	cancel := a.cancel
	a.state = StateStopping
	a.mu.Unlock()
	m.broadcastState(a, false)

	// Signal the monitor that this is an intentional stop.
	if cancel != nil {
		select {
		case <-cancel:
		default:
			close(cancel)
		}
	}

	if grace <= 0 {
		grace = m.stopGrace
	}
	if run != nil {
		if err := run.Stop(grace); err != nil {
			return fmt.Errorf("%w: %v", ErrInternal, err)
		}
	}
	return nil
}

// StopAll stops every agent that is in a stoppable state. It is the
// orchestrator / main-agent "Stop all work" control.
func (m *Manager) StopAll() {
	m.mu.Lock()
	all := make([]*Agent, 0, len(m.agents))
	for _, a := range m.agents {
		all = append(all, a)
	}
	m.mu.Unlock()

	for _, a := range all {
		a.mu.Lock()
		stoppable := canTransition(a.state, StateStopping)
		a.mu.Unlock()
		if stoppable {
			_ = m.stopAgent(a, m.stopGrace)
		}
	}
}

// Whip is the cambuk gag. It has NO effect on the process: it emits a one-shot
// agent.state with whipped=true (the UI animates it) immediately followed by the
// normal state with whipped=false. The run state is unchanged.
func (m *Manager) Whip(id string) error {
	a, ok := m.get(id)
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownAgent, id)
	}
	m.broadcastState(a, true)
	m.broadcastState(a, false)
	return nil
}

// State returns the current state of an agent (used by tests and callers).
func (m *Manager) State(id string) (State, bool) {
	a, ok := m.get(id)
	if !ok {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state, true
}

// Restarts returns the agent's current restart counter (used by tests).
func (m *Manager) Restarts(id string) (int, bool) {
	a, ok := m.get(id)
	if !ok {
		return 0, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.restarts, true
}

// Shutdown stops all agents; used on daemon shutdown.
func (m *Manager) Shutdown() {
	m.StopAll()
}
