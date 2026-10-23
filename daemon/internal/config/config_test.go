package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDefaultHasMockAgents asserts zero-config defaults include demoable mock
// agents and sane address/data dir.
func TestDefaultHasMockAgents(t *testing.T) {
	c := Default()
	if c.Addr != DefaultAddr {
		t.Fatalf("addr = %q, want %q", c.Addr, DefaultAddr)
	}
	if c.DataDir != DefaultDataDir {
		t.Fatalf("dataDir = %q, want %q", c.DataDir, DefaultDataDir)
	}
	if len(c.Agents) == 0 {
		t.Fatalf("expected at least one default agent")
	}
	for _, a := range c.Agents {
		if a.Adapter != "mock" {
			t.Fatalf("default agent %q adapter = %q, want mock", a.ID, a.Adapter)
		}
	}
}

// TestLoadMergesFile asserts a partial file overrides only specified fields and
// that a provided agents list replaces the defaults.
func TestLoadMergesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cfg.json")
	content := `{"addr":":9000","agents":[{"id":"c1","displayName":"Claude","adapter":"claude","argv":["claude","--foo"]}]}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Addr != ":9000" {
		t.Fatalf("addr = %q, want :9000", c.Addr)
	}
	if c.DataDir != DefaultDataDir {
		t.Fatalf("dataDir should stay default, got %q", c.DataDir)
	}
	if len(c.Agents) != 1 || c.Agents[0].Adapter != "claude" {
		t.Fatalf("agents not replaced from file: %+v", c.Agents)
	}
	if len(c.Agents[0].Argv) != 2 {
		t.Fatalf("argv not loaded: %+v", c.Agents[0].Argv)
	}
}

// TestApplyOverrides asserts CLI flags override config values.
func TestApplyOverrides(t *testing.T) {
	c := Default()
	c.ApplyOverrides(":1234", "/tmp/x")
	if c.Addr != ":1234" || c.DataDir != "/tmp/x" {
		t.Fatalf("overrides not applied: %+v", c)
	}
	// Empty overrides leave values unchanged.
	c.ApplyOverrides("", "")
	if c.Addr != ":1234" || c.DataDir != "/tmp/x" {
		t.Fatalf("empty overrides changed values: %+v", c)
	}
}
