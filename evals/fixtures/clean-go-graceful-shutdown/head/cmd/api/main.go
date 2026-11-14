package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"example.com/shop/internal/api"
	"example.com/shop/internal/config"
	"example.com/shop/internal/server"
)

// shutdownTimeout must stay below the platform's kill timeout (30s on our cluster).
const shutdownTimeout = 20 * time.Second

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("load config", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           api.NewRouter(cfg),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	slog.Info("listening", "addr", cfg.ListenAddr)
	if err := server.Run(ctx, srv, shutdownTimeout); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
	slog.Info("server stopped cleanly")
}
