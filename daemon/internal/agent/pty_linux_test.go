//go:build linux

package agent

import (
	"bufio"
	"io"
	"strings"
	"testing"
	"time"
)

// TestPTYRunnerEcho launches a real process under the stdlib PTY and confirms
// its output streams back. This proves the /dev/ptmx + ioctl primitive works on
// this kernel. It uses /bin/echo so it needs no special CLI.
func TestPTYRunnerEcho(t *testing.T) {
	if !ptySupported() {
		t.Skip("pty not supported on this platform")
	}
	r := newPTYRunner([]string{"/bin/echo", "pty-ok"}, nil, "")
	if err := r.Start(); err != nil {
		t.Skipf("pty unavailable in this environment: %v", err)
	}

	var sb strings.Builder
	done := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(readerFromChan(r.Output()))
		for sc.Scan() {
			sb.WriteString(sc.Text())
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out reading pty output")
	}
	r.Wait()

	if !strings.Contains(sb.String(), "pty-ok") {
		t.Fatalf("expected echoed output, got %q", sb.String())
	}
}

// readerFromChan adapts an OutputChunk channel to an io.Reader for the scanner.
type chanReader struct {
	ch  <-chan OutputChunk
	buf []byte
}

func readerFromChan(ch <-chan OutputChunk) *chanReader { return &chanReader{ch: ch} }

func (r *chanReader) Read(p []byte) (int, error) {
	for len(r.buf) == 0 {
		chunk, ok := <-r.ch
		if !ok {
			return 0, io.EOF
		}
		r.buf = []byte(chunk.Data)
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}
