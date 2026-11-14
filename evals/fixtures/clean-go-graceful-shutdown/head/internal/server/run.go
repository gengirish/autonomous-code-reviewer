// Package server runs an HTTP server with graceful shutdown.
package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Run serves srv until ctx is cancelled, then stops accepting connections and waits up to
// shutdownTimeout for in-flight requests to finish. It returns nil after a clean shutdown,
// and the serve error if the server failed on its own (for example, the port was taken).
func Run(ctx context.Context, srv *http.Server, shutdownTimeout time.Duration) error {
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}
