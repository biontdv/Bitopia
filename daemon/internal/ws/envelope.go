// Package ws implements a dependency-free WebSocket server (RFC 6455) using
// only the Go standard library, plus the typed JSON envelope and a broadcast
// hub used by the daemon. No third-party modules are used because the build
// sandbox cannot reach external module registries.
package ws

import (
	"encoding/json"
	"time"
)

// Envelope is the single uniform JSON message shape exchanged over the
// WebSocket. The frontend routes on Type and preserves ordering with Seq.
type Envelope struct {
	Type    string          `json:"type"`
	AgentID string          `json:"agentId,omitempty"`
	Seq     uint64          `json:"seq"`
	Ts      int64           `json:"ts"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// NowMillis returns the current Unix time in milliseconds, matching the ts
// field used throughout the protocol.
func NowMillis() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}

// NewEnvelope builds an Envelope of the given type for the given agent, marshals
// the payload (which may be nil), and stamps ts with the current time. Seq is
// left at zero for the caller (or hub) to assign.
func NewEnvelope(msgType, agentID string, payload any) (Envelope, error) {
	e := Envelope{
		Type:    msgType,
		AgentID: agentID,
		Ts:      NowMillis(),
	}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return Envelope{}, err
		}
		e.Payload = raw
	}
	return e, nil
}

// MustEnvelope is like NewEnvelope but panics on a marshal error. It is only
// used with payloads that are known to be marshalable (plain structs/maps).
func MustEnvelope(msgType, agentID string, payload any) Envelope {
	e, err := NewEnvelope(msgType, agentID, payload)
	if err != nil {
		panic("ws: failed to marshal envelope payload: " + err.Error())
	}
	return e
}

// ErrorPayload is the body of an "error" envelope.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes used across the daemon.
const (
	CodeBadRequest        = "bad_request"
	CodeUnknownType       = "unknown_type"
	CodeUnknownAgent      = "unknown_agent"
	CodeInvalidTransition = "invalid_transition"
	CodeLogoTooLarge      = "logo_too_large"
	CodeLogoBadType       = "logo_bad_type"
	CodeInternal          = "internal"
)

// ErrorEnvelope is a convenience constructor for an error message.
func ErrorEnvelope(agentID, code, message string) Envelope {
	return MustEnvelope("error", agentID, ErrorPayload{Code: code, Message: message})
}
