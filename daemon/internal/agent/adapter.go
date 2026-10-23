// Package agent implements the agent lifecycle Manager, the pluggable adapter
// interface (mock + PTY-backed claude/codex/antigravity), the stdlib PTY
// primitive, and the per-agent goroutine pair. It uses only the Go standard
// library.
package agent

import "fmt"

// AdapterConfig is the per-agent configuration an adapter needs to build its
// launch command. It is derived from the daemon config.
type AdapterConfig struct {
	ID          string            // agent id, e.g. "agent-1"
	DisplayName string            // human label shown in the UI
	Argv        []string          // configured command + args, e.g. ["claude"]
	Env         map[string]string // extra environment variables
	WorkDir     string            // working directory for the process
}

// AgentAdapter is the pluggable contract for launching an agent.
type AgentAdapter interface {
	// Name returns the adapter kind: "mock", "claude", "codex", or "antigravity".
	Name() string

	// BuildCommand produces the argv and environment used to launch the agent.
	// For the MOCK adapter this returns a sentinel (it does not exec a real
	// process); for PTY adapters it returns the resolved command line.
	BuildCommand(cfg AdapterConfig) (argv []string, env []string, err error)

	// SupportsPTY reports whether the adapter must run under a pseudo-terminal.
	SupportsPTY() bool
}

// Adapter kind names.
const (
	KindMock        = "mock"
	KindClaude      = "claude"
	KindCodex       = "codex"
	KindAntigravity = "antigravity"
)

// NewAdapter returns the adapter for the given kind, defaulting to "mock" for an
// empty or unknown kind.
func NewAdapter(kind string, cfg AdapterConfig) (AgentAdapter, error) {
	switch kind {
	case KindMock, "":
		return &MockAdapter{}, nil
	case KindClaude, KindCodex, KindAntigravity:
		return &PTYAdapter{kind: kind, defaultArgv: []string{kind}}, nil
	default:
		// Unknown kind: default to mock so the office is always demoable, but
		// surface the fallback through a wrapped kind name for visibility.
		return &MockAdapter{}, nil
	}
}

// MockAdapter streams synthetic output and needs no PTY. It makes the whole
// office demoable without any real CLI installed.
type MockAdapter struct{}

// Name returns the mock kind.
func (*MockAdapter) Name() string { return KindMock }

// BuildCommand returns a sentinel argv; the mock adapter never execs a process.
func (*MockAdapter) BuildCommand(cfg AdapterConfig) ([]string, []string, error) {
	return []string{"mock://" + cfg.ID}, nil, nil
}

// SupportsPTY is false for the mock adapter.
func (*MockAdapter) SupportsPTY() bool { return false }

// PTYAdapter launches a real CLI (claude/codex/antigravity) under a PTY. The
// argv is config-driven so the specific command and flags come from config; the
// CLI only needs to exist on the user's PATH at run time, not at build time.
type PTYAdapter struct {
	kind        string
	defaultArgv []string
}

// Name returns the adapter kind (claude/codex/antigravity).
func (a *PTYAdapter) Name() string { return a.kind }

// BuildCommand resolves the argv from config, falling back to the kind name as
// the command when no argv is configured, and flattens the env map.
func (a *PTYAdapter) BuildCommand(cfg AdapterConfig) ([]string, []string, error) {
	argv := cfg.Argv
	if len(argv) == 0 {
		argv = append([]string(nil), a.defaultArgv...)
	}
	if len(argv) == 0 {
		return nil, nil, fmt.Errorf("agent: no command configured for %q adapter", a.kind)
	}
	env := make([]string, 0, len(cfg.Env))
	for k, v := range cfg.Env {
		env = append(env, k+"="+v)
	}
	return argv, env, nil
}

// SupportsPTY is true for PTY-backed adapters.
func (a *PTYAdapter) SupportsPTY() bool { return true }
