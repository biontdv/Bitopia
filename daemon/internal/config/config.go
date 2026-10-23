// Package config loads the daemon configuration from an optional JSON file and
// applies sensible zero-config defaults so the office runs with no setup. It
// uses only the Go standard library.
package config

import (
	"encoding/json"
	"fmt"
	"os"
)

// AgentConfig is a single named agent definition.
type AgentConfig struct {
	ID          string            `json:"id"`
	DisplayName string            `json:"displayName"`
	Adapter     string            `json:"adapter"` // mock | claude | codex | antigravity
	Argv        []string          `json:"argv,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	WorkDir     string            `json:"workDir,omitempty"`
}

// Config is the full daemon configuration.
type Config struct {
	Addr    string        `json:"addr"`
	DataDir string        `json:"dataDir"`
	Agents  []AgentConfig `json:"agents"`
}

// Defaults for zero-config operation.
const (
	DefaultAddr    = ":8080"
	DefaultDataDir = "./data"
)

// Default returns a configuration with a couple of preconfigured MOCK agents so
// the office is immediately demoable without any real CLI or config file.
func Default() Config {
	return Config{
		Addr:    DefaultAddr,
		DataDir: DefaultDataDir,
		Agents: []AgentConfig{
			{ID: "agent-1", DisplayName: "Mock Agent 1", Adapter: "mock"},
			{ID: "agent-2", DisplayName: "Mock Agent 2", Adapter: "mock"},
		},
	}
}

// Load reads configuration from path (if non-empty), falling back to defaults
// for any unset fields. An empty path returns the defaults.
func Load(path string) (Config, error) {
	cfg := Default()
	if path == "" {
		return cfg, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("config: read %s: %w", path, err)
	}

	// Unmarshal into a config that starts from defaults so a partial file only
	// overrides what it specifies, except agents which replace wholesale when
	// provided.
	var fileCfg Config
	if err := json.Unmarshal(data, &fileCfg); err != nil {
		return Config{}, fmt.Errorf("config: parse %s: %w", path, err)
	}

	if fileCfg.Addr != "" {
		cfg.Addr = fileCfg.Addr
	}
	if fileCfg.DataDir != "" {
		cfg.DataDir = fileCfg.DataDir
	}
	if len(fileCfg.Agents) > 0 {
		cfg.Agents = fileCfg.Agents
	}
	return cfg, nil
}

// ApplyOverrides applies non-empty CLI flag overrides on top of a config.
func (c *Config) ApplyOverrides(addr, dataDir string) {
	if addr != "" {
		c.Addr = addr
	}
	if dataDir != "" {
		c.DataDir = dataDir
	}
}
