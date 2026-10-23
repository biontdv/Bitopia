package ws

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// wsGUID is the RFC 6455 magic string appended to the client key before hashing.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocket opcodes (RFC 6455 section 5.2).
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// maxFramePayload caps a single inbound frame payload to guard against abusive
// clients. 16 MiB is comfortably larger than any control message the UI sends.
const maxFramePayload = 16 << 20

// ErrConnClosed is returned by readFrame when a close frame is received.
var ErrConnClosed = errors.New("ws: connection closed")

// acceptKey computes the Sec-WebSocket-Accept value for a given
// Sec-WebSocket-Key per RFC 6455: base64(sha1(key + GUID)).
func acceptKey(key string) string {
	h := sha1.New()
	io.WriteString(h, key+wsGUID)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// frame is a decoded WebSocket frame.
type frame struct {
	fin     bool
	opcode  byte
	payload []byte
}

// readFrame reads a single WebSocket frame from r. Client->server frames MUST
// be masked (RFC 6455 section 5.1); an unmasked client frame is a protocol
// error. The mask is applied in place to recover the payload.
func readFrame(r io.Reader) (frame, error) {
	var header [2]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return frame{}, err
	}

	fin := header[0]&0x80 != 0
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return frame{}, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return frame{}, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	if length > maxFramePayload {
		return frame{}, fmt.Errorf("ws: frame payload too large: %d", length)
	}

	if !masked {
		// Per spec the server MUST close on an unmasked client frame.
		return frame{}, errors.New("ws: client frame is not masked")
	}

	var maskKey [4]byte
	if _, err := io.ReadFull(r, maskKey[:]); err != nil {
		return frame{}, err
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return frame{}, err
	}
	for i := range payload {
		payload[i] ^= maskKey[i%4]
	}

	return frame{fin: fin, opcode: opcode, payload: payload}, nil
}

// writeFrame writes a single unmasked server->client frame. Server frames MUST
// NOT be masked (RFC 6455 section 5.1).
func writeFrame(w io.Writer, opcode byte, payload []byte) error {
	var header []byte
	b0 := byte(0x80) | opcode // FIN set; we never fragment outgoing frames.
	length := len(payload)

	switch {
	case length < 126:
		header = []byte{b0, byte(length)}
	case length <= 0xFFFF:
		header = make([]byte, 4)
		header[0] = b0
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:], uint16(length))
	default:
		header = make([]byte, 10)
		header[0] = b0
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(length))
	}

	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// encodeTextFrame returns the raw bytes of a complete unmasked text frame.
// It is used by tests and callers that want to buffer a frame.
func encodeTextFrame(payload []byte) []byte {
	buf := &byteBuffer{}
	_ = writeFrame(buf, opText, payload)
	return buf.b
}

// byteBuffer is a tiny io.Writer accumulator to avoid importing bytes where a
// minimal helper suffices; using the stdlib bytes.Buffer would be equally fine.
type byteBuffer struct{ b []byte }

func (w *byteBuffer) Write(p []byte) (int, error) {
	w.b = append(w.b, p...)
	return len(p), nil
}
