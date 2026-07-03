package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/httpapi"
	"go.uber.org/zap"
)

// App wires shared runtime handles for CLI commands.
type App struct {
	Config config.Config
	Logger *zap.Logger
}

// New constructs an App with a production Zap logger for the configured log level.
func New(cfg config.Config) (*App, error) {
	logger, err := newLogger(cfg.LogLevel)
	if err != nil {
		return nil, err
	}

	return &App{
		Config: cfg,
		Logger: logger,
	}, nil
}

// Serve starts the HTTP API until the context is canceled.
func (a *App) Serve(ctx context.Context) error {
	router := httpapi.NewRouter(a.Logger)
	server := &http.Server{
		Addr:    a.Config.ListenAddress,
		Handler: router,
	}

	errCh := make(chan error, 1)
	go func() {
		a.Logger.Info("http server listening", zap.String("addr", a.Config.ListenAddress))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown http server: %w", err)
		}
		return nil
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	}
}

// Close flushes logger state.
func (a *App) Close() error {
	return a.Logger.Sync()
}

func newLogger(level string) (*zap.Logger, error) {
	cfg := zap.NewProductionConfig()
	if err := cfg.Level.UnmarshalText([]byte(level)); err != nil {
		return nil, fmt.Errorf("parse log level: %w", err)
	}
	return cfg.Build()
}
