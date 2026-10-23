package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentic-office/daemon/internal/config"
	"github.com/agentic-office/daemon/internal/office"
	"github.com/agentic-office/daemon/internal/ws"
)

// newTestServer spins up the daemon handler on an httptest server with a temp
// data dir and a single mock agent.
func newTestServer(t *testing.T) (*httptest.Server, *server) {
	t.Helper()
	cfg := config.Config{
		Addr:    ":0",
		DataDir: t.TempDir(),
		Agents: []config.AgentConfig{
			{ID: "agent-1", DisplayName: "Mock 1", Adapter: "mock"},
		},
	}
	store, err := office.NewStore(cfg.DataDir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	srv := newServer(cfg, store)
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)
	return ts, srv
}

// TestHealthz confirms GET /healthz returns 200.
func TestHealthz(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", resp.StatusCode)
	}
}

// TestStaticIndex confirms the embedded UI is served at /.
func TestStaticIndex(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("index status = %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), "Agentic Virtual Office") {
		t.Fatalf("index did not contain expected content")
	}
}

// wsClient is a minimal stdlib WebSocket client for the smoke test.
type wsClient struct {
	conn net.Conn
	br   *bufio.Reader
}

func dialWS(t *testing.T, httpURL string) *wsClient {
	t.Helper()
	u := strings.TrimPrefix(httpURL, "http://")
	conn, err := net.Dial("tcp", u)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	keyBytes := make([]byte, 16)
	_, _ = rand.Read(keyBytes)
	key := base64.StdEncoding.EncodeToString(keyBytes)

	req := "GET /ws HTTP/1.1\r\n" +
		"Host: " + u + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	br := bufio.NewReader(conn)
	// Read the handshake response status line + headers.
	statusLine, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101 Switching Protocols, got %q", statusLine)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	return &wsClient{conn: conn, br: br}
}

// writeText sends a masked client text frame.
func (c *wsClient) writeText(payload []byte) error {
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	out := []byte{0x81} // FIN + text
	n := len(payload)
	switch {
	case n < 126:
		out = append(out, 0x80|byte(n))
	case n <= 0xFFFF:
		out = append(out, 0x80|126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(n))
		out = append(out, ext[:]...)
	default:
		out = append(out, 0x80|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		out = append(out, ext[:]...)
	}
	out = append(out, mask[:]...)
	for i, b := range payload {
		out = append(out, b^mask[i%4])
	}
	_, err := c.conn.Write(out)
	return err
}

// readText reads a single server text frame payload (server frames are unmasked).
func (c *wsClient) readText(t *testing.T) []byte {
	t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var h [2]byte
	if _, err := io.ReadFull(c.br, h[:]); err != nil {
		t.Fatalf("read frame header: %v", err)
	}
	length := uint64(h[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		_, _ = io.ReadFull(c.br, ext[:])
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		_, _ = io.ReadFull(c.br, ext[:])
		length = binary.BigEndian.Uint64(ext[:])
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		t.Fatalf("read payload: %v", err)
	}
	return payload
}

// TestWebSocketRoundTrip performs the full upgrade, sends office.get, and
// confirms an office.state envelope comes back. This exercises the handshake,
// the frame codec, and the command router end to end.
func TestWebSocketRoundTrip(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dialWS(t, ts.URL)
	defer c.conn.Close()

	env, _ := ws.NewEnvelope("office.get", "", map[string]any{})
	data, _ := json.Marshal(env)
	if err := c.writeText(data); err != nil {
		t.Fatalf("writeText: %v", err)
	}

	// Read until we see an office.state envelope (there may be other broadcasts).
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var reply ws.Envelope
		if err := json.Unmarshal(c.readText(t), &reply); err != nil {
			continue
		}
		if reply.Type == "office.state" {
			var o office.Office
			if err := json.Unmarshal(reply.Payload, &o); err != nil {
				t.Fatalf("office payload: %v", err)
			}
			if o.ID == "" {
				t.Fatalf("expected a non-empty office id")
			}
			return
		}
	}
	t.Fatalf("did not receive office.state")
}

// TestWebSocketAgentControl drives start then stop over the WebSocket and
// confirms state envelopes reflect the transitions.
func TestWebSocketAgentControl(t *testing.T) {
	ts, _ := newTestServer(t)
	c := dialWS(t, ts.URL)
	defer c.conn.Close()

	send := func(typ, agentID string, payload any) {
		env := ws.MustEnvelope(typ, agentID, payload)
		data, _ := json.Marshal(env)
		if err := c.writeText(data); err != nil {
			t.Fatalf("send %s: %v", typ, err)
		}
	}

	send("agent.start", "agent-1", map[string]any{})

	sawRunning := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !sawRunning {
		var reply ws.Envelope
		if err := json.Unmarshal(c.readText(t), &reply); err != nil {
			continue
		}
		if reply.Type == "agent.state" && reply.AgentID == "agent-1" {
			var p struct {
				State string `json:"state"`
			}
			_ = json.Unmarshal(reply.Payload, &p)
			if p.State == "running" {
				sawRunning = true
			}
		}
	}
	if !sawRunning {
		t.Fatalf("never observed agent-1 running")
	}

	send("agent.stop", "agent-1", map[string]any{"graceMs": 200})
	sawStopped := false
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !sawStopped {
		var reply ws.Envelope
		if err := json.Unmarshal(c.readText(t), &reply); err != nil {
			continue
		}
		if reply.Type == "agent.state" && reply.AgentID == "agent-1" {
			var p struct {
				State string `json:"state"`
			}
			_ = json.Unmarshal(reply.Payload, &p)
			if p.State == "stopped" {
				sawStopped = true
			}
		}
	}
	if !sawStopped {
		t.Fatalf("never observed agent-1 stopped")
	}
}
