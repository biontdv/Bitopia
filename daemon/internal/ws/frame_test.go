package ws

import (
	"bytes"
	"testing"
)

// TestAcceptKey verifies the Sec-WebSocket-Accept computation against the
// canonical example from RFC 6455 section 1.3. If the handshake math were
// reverted (wrong GUID, wrong hash, wrong encoding) this test fails.
func TestAcceptKey(t *testing.T) {
	const key = "dGhlIHNhbXBsZSBub25jZQ=="
	const want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got := acceptKey(key); got != want {
		t.Fatalf("acceptKey(%q) = %q, want %q", key, got, want)
	}
}

// maskFrame builds a masked client->server frame for the given opcode and
// payload, mirroring what a real browser client would send.
func maskFrame(opcode byte, payload []byte, mask [4]byte) []byte {
	out := []byte{0x80 | opcode}
	length := len(payload)
	switch {
	case length < 126:
		out = append(out, 0x80|byte(length))
	case length <= 0xFFFF:
		out = append(out, 0x80|126, byte(length>>8), byte(length))
	default:
		out = append(out, 0x80|127,
			byte(length>>56), byte(length>>48), byte(length>>40), byte(length>>32),
			byte(length>>24), byte(length>>16), byte(length>>8), byte(length))
	}
	out = append(out, mask[:]...)
	for i, b := range payload {
		out = append(out, b^mask[i%4])
	}
	return out
}

// TestFrameRoundTrip encodes a server text frame, confirms it is unmasked, then
// masks it as a client would and decodes it back, asserting the payload and
// opcode survive the round trip.
func TestFrameRoundTrip(t *testing.T) {
	payloads := [][]byte{
		[]byte("hello"),
		[]byte(""),
		bytes.Repeat([]byte("x"), 130),   // forces 16-bit extended length
		bytes.Repeat([]byte("y"), 70000), // forces 64-bit extended length
	}

	for _, p := range payloads {
		// Server-side encode: must be unmasked (high mask bit clear).
		encoded := encodeTextFrame(p)
		if len(encoded) < 2 {
			t.Fatalf("encoded frame too short")
		}
		if encoded[1]&0x80 != 0 {
			t.Fatalf("server frame must not be masked")
		}

		// Client-side: mask the same payload and decode via readFrame.
		mask := [4]byte{0x12, 0x34, 0x56, 0x78}
		client := maskFrame(opText, p, mask)
		fr, err := readFrame(bytes.NewReader(client))
		if err != nil {
			t.Fatalf("readFrame error for len %d: %v", len(p), err)
		}
		if fr.opcode != opText {
			t.Fatalf("opcode = %d, want %d", fr.opcode, opText)
		}
		if !fr.fin {
			t.Fatalf("fin should be set")
		}
		if !bytes.Equal(fr.payload, p) {
			t.Fatalf("payload mismatch for len %d", len(p))
		}
	}
}

// TestReadFrameRejectsUnmaskedClient verifies the server rejects an unmasked
// client frame per RFC 6455 section 5.1.
func TestReadFrameRejectsUnmaskedClient(t *testing.T) {
	// FIN + text, no mask bit, length 0.
	unmasked := []byte{0x81, 0x00}
	if _, err := readFrame(bytes.NewReader(unmasked)); err == nil {
		t.Fatalf("expected error for unmasked client frame")
	}
}
