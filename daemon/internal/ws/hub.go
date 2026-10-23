package ws

import (
	"bufio"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
)

// CommandHandler receives a decoded client->server envelope. Implementations
// (the daemon) route it to the agent Manager or office store. The conn is the
// originating connection, useful for targeted error replies.
type CommandHandler func(conn *Conn, env Envelope)

// Hub tracks connected clients and broadcasts envelopes to all of them. A
// per-connection buffered send channel means a slow client cannot block the
// hub or other clients.
type Hub struct {
	mu      sync.RWMutex
	conns   map[*Conn]struct{}
	seq     atomic.Uint64
	handler CommandHandler
}

// NewHub creates an empty hub. handler is invoked for every client command;
// it may be nil (commands are then ignored).
func NewHub(handler CommandHandler) *Hub {
	return &Hub{
		conns:   make(map[*Conn]struct{}),
		handler: handler,
	}
}

// nextSeq returns the next hub-wide sequence number.
func (h *Hub) nextSeq() uint64 {
	return h.seq.Add(1)
}

// Register adds a connection to the hub.
func (h *Hub) Register(c *Conn) {
	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.mu.Unlock()
}

// Unregister removes a connection from the hub and closes its send channel.
func (h *Hub) Unregister(c *Conn) {
	h.mu.Lock()
	if _, ok := h.conns[c]; ok {
		delete(h.conns, c)
		c.close()
	}
	h.mu.Unlock()
}

// Broadcast assigns a hub sequence number and sends the envelope to every
// connected client. Slow clients that cannot keep up drop the message rather
// than block the broadcast.
func (h *Hub) Broadcast(env Envelope) {
	env.Seq = h.nextSeq()
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	h.mu.RLock()
	for c := range h.conns {
		c.trySend(data)
	}
	h.mu.RUnlock()
}

// Clients returns the number of currently connected clients.
func (h *Hub) Clients() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

// Conn is a single WebSocket connection. Writes go through a buffered channel
// drained by a dedicated writer goroutine so broadcasts never block.
type Conn struct {
	hub      *Hub
	rw       *bufio.ReadWriter
	closer   func() error
	send     chan []byte
	closeOne sync.Once
	closed   chan struct{}
}

const sendBuffer = 256

// trySend enqueues data for the writer goroutine. If the buffer is full (slow
// client) the message is dropped to protect the hub.
func (c *Conn) trySend(data []byte) {
	select {
	case c.send <- data:
	case <-c.closed:
	default:
		// Buffer full: drop to avoid blocking the broadcast.
	}
}

// Send marshals and enqueues an envelope to this single connection.
func (c *Conn) Send(env Envelope) {
	if env.Seq == 0 {
		env.Seq = c.hub.nextSeq()
	}
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	c.trySend(data)
}

func (c *Conn) close() {
	c.closeOne.Do(func() {
		close(c.closed)
		if c.closer != nil {
			_ = c.closer()
		}
	})
}

// Handler returns an http.HandlerFunc that upgrades matching requests to
// WebSocket and serves them against this hub.
func (h *Hub) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h.serve(w, r); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
	}
}

// serve performs the RFC 6455 handshake and runs the read/write loops.
func (h *Hub) serve(w http.ResponseWriter, r *http.Request) error {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return errors.New("ws: not a websocket upgrade request")
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return errors.New("ws: missing Connection: Upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return errors.New("ws: missing Sec-WebSocket-Key")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return errors.New("ws: response writer does not support hijacking")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return err
	}

	accept := acceptKey(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		netConn.Close()
		return err
	}
	if err := brw.Flush(); err != nil {
		netConn.Close()
		return err
	}

	conn := &Conn{
		hub:    h,
		rw:     brw,
		closer: netConn.Close,
		send:   make(chan []byte, sendBuffer),
		closed: make(chan struct{}),
	}
	h.Register(conn)

	go conn.writeLoop()
	conn.readLoop()
	return nil
}

// writeLoop drains the send channel, writing each message as a text frame.
func (c *Conn) writeLoop() {
	for {
		select {
		case <-c.closed:
			return
		case data, ok := <-c.send:
			if !ok {
				return
			}
			if err := writeFrame(c.rw, opText, data); err != nil {
				c.hub.Unregister(c)
				return
			}
			if err := c.rw.Flush(); err != nil {
				c.hub.Unregister(c)
				return
			}
		}
	}
}

// readLoop reads frames, replies to control frames, and dispatches text frames
// as decoded envelopes to the hub handler. It runs until the connection closes.
func (c *Conn) readLoop() {
	defer c.hub.Unregister(c)
	for {
		fr, err := readFrame(c.rw)
		if err != nil {
			return
		}
		switch fr.opcode {
		case opText, opBinary:
			var env Envelope
			if err := json.Unmarshal(fr.payload, &env); err != nil {
				c.Send(ErrorEnvelope("", CodeBadRequest, "invalid JSON envelope"))
				continue
			}
			if c.hub.handler != nil {
				c.hub.handler(c, env)
			}
		case opPing:
			// Respond with a pong carrying the same application data.
			if err := writeFrame(c.rw, opPong, fr.payload); err != nil {
				return
			}
			_ = c.rw.Flush()
		case opPong:
			// Ignore unsolicited pongs.
		case opClose:
			// Echo a close frame and terminate.
			_ = writeFrame(c.rw, opClose, fr.payload)
			_ = c.rw.Flush()
			return
		}
	}
}
