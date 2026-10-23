// Protocol types and helpers for the WebSocket contract defined in DESIGN.md
// section 2. Both frontends speak this exact shape; this fallback UI uses only
// the DOM lib and no external packages.
// Build an outgoing client->server envelope. Client messages may send seq 0.
export function command(type, agentId, payload) {
    return {
        type,
        agentId,
        seq: 0,
        ts: Date.now(),
        payload,
    };
}
