package proxy

import (
	"context"
	"errors"
	"io"
	"sync"
)

// closeWriter is implemented by conns that can shut down their write side
// without tearing down the read side, e.g. *net.TCPConn and *tls.Conn.
type closeWriter interface {
	CloseWrite() error
}

// closeWrite ends one direction so the peer observes EOF while the opposite
// direction keeps flowing. Conns without CloseWrite fall back to Close; yamux
// streams land here and their Close already sends a FIN and keeps reading.
func closeWrite(c io.ReadWriteCloser) {
	if cw, ok := c.(closeWriter); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

// Relay copies bytes in both directions until both sides end or ctx is
// canceled. When one direction ends cleanly, only the peer's write side is
// shut down, propagating TCP half-close semantics; a copy error aborts both.
func Relay(ctx context.Context, a, b io.ReadWriteCloser) error {
	var once sync.Once
	var resErr error
	setErr := func(err error) {
		if err != nil && !errors.Is(err, io.ErrClosedPipe) {
			once.Do(func() { resErr = err })
		}
	}

	doneA := make(chan struct{})
	doneB := make(chan struct{})

	copyDir := func(done chan<- struct{}, dst, src io.ReadWriteCloser) {
		defer close(done)
		if _, err := io.Copy(dst, src); err != nil {
			setErr(err)
			_ = dst.Close()
			_ = src.Close()
			return
		}
		closeWrite(dst)
	}

	go copyDir(doneA, a, b)
	go copyDir(doneB, b, a)

	ctxDone := ctx.Done()
	aOpen, bOpen := doneA, doneB
	for aOpen != nil || bOpen != nil {
		select {
		case <-ctxDone:
			ctxDone = nil
			once.Do(func() { resErr = ctx.Err() })
			_ = a.Close()
			_ = b.Close()
		case <-aOpen:
			aOpen = nil
		case <-bOpen:
			bOpen = nil
		}
	}

	_ = a.Close()
	_ = b.Close()
	return resErr
}
