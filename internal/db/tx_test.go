package db

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/uptrace/bun"
)

func TestWithImmediateTxAcquiresWriteLock(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "immediate-lock.db")

	holder, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open holder database: %v", err)
	}
	t.Cleanup(func() { _ = holder.Close() })

	waiter, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open waiter database: %v", err)
	}
	t.Cleanup(func() { _ = waiter.Close() })

	holderReady := make(chan struct{})
	releaseHolder := make(chan struct{})

	go func() {
		err := holder.WithImmediateTx(ctx, func(ctx context.Context, tx bun.IDB) error {
			close(holderReady)
			<-releaseHolder
			return nil
		})
		if err != nil {
			t.Errorf("holder immediate transaction: %v", err)
		}
	}()

	<-holderReady

	waiterDone := make(chan error, 1)
	go func() {
		waiterDone <- waiter.WithImmediateTx(ctx, func(ctx context.Context, tx bun.IDB) error {
			return nil
		})
	}()

	select {
	case err := <-waiterDone:
		t.Fatalf("second immediate transaction completed early: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	close(releaseHolder)

	select {
	case err := <-waiterDone:
		if err != nil {
			t.Fatalf("waiter immediate transaction: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for waiter immediate transaction")
	}
}

func TestWithTxDoesNotBlockImmediateWriteLock(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "deferred-lock.db")

	holder, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open holder database: %v", err)
	}
	t.Cleanup(func() { _ = holder.Close() })

	waiter, err := Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("open waiter database: %v", err)
	}
	t.Cleanup(func() { _ = waiter.Close() })

	holderReady := make(chan struct{})
	releaseHolder := make(chan struct{})

	go func() {
		err := holder.WithTx(ctx, func(ctx context.Context, tx bun.Tx) error {
			close(holderReady)
			<-releaseHolder
			return nil
		})
		if err != nil {
			t.Errorf("holder deferred transaction: %v", err)
		}
	}()

	<-holderReady

	waiterDone := make(chan error, 1)
	go func() {
		waiterDone <- waiter.WithImmediateTx(ctx, func(ctx context.Context, tx bun.IDB) error {
			return nil
		})
	}()

	select {
	case err := <-waiterDone:
		if err != nil {
			t.Fatalf("waiter immediate transaction: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for waiter immediate transaction")
	}

	close(releaseHolder)
}
