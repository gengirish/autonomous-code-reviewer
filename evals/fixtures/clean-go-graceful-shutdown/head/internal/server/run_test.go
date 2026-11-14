package server

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return addr
}

func TestRunWaitsForInFlightRequests(t *testing.T) {
	addr := freeAddr(t)
	started := make(chan struct{})
	srv := &http.Server{
		Addr: addr,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			time.Sleep(200 * time.Millisecond)
			w.WriteHeader(http.StatusNoContent)
		}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, srv, 2*time.Second) }()

	respCh := make(chan *http.Response, 1)
	go func() {
		for {
			resp, err := http.Get("http://" + addr)
			if err == nil {
				respCh <- resp
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	<-started
	cancel()

	resp := <-respCh
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("in-flight request got %d, want 204", resp.StatusCode)
	}
	if err := <-done; err != nil {
		t.Fatalf("Run returned %v, want nil after a clean shutdown", err)
	}
}

func TestRunReturnsServeErrors(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	srv := &http.Server{Addr: l.Addr().String()}
	if err := Run(context.Background(), srv, time.Second); err == nil {
		t.Fatal("Run returned nil for a port that is already in use")
	}
}
