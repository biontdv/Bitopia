package agent

import "errors"

// Sentinel errors returned by the Manager. The daemon maps these to WebSocket
// error codes (see internal/ws).
var (
	// ErrUnknownAgent is returned when an agent id is not registered.
	ErrUnknownAgent = errors.New("unknown agent")
	// ErrInvalidTransition is returned when a command is illegal for the
	// agent's current state.
	ErrInvalidTransition = errors.New("invalid transition")
	// ErrInternal wraps an internal failure (adapter/runner error).
	ErrInternal = errors.New("internal error")
)
