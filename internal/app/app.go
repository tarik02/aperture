package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/httpapi"
	"github.com/aperture/aperture/internal/overlay"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/supervisor"
	"github.com/aperture/aperture/internal/systemd"
	"github.com/aperture/aperture/internal/traefik"
	"go.uber.org/zap"
)

// App wires shared runtime handles for CLI commands.
type App struct {
	Config     config.Config
	Logger     *zap.Logger
	DB         *db.DB
	Repository *db.Repository
	Auth       *auth.Service
	Sessions   *session.Service
}

// New constructs an App with a production Zap logger and opens the configured database.
func New(ctx context.Context, cfg config.Config) (*App, error) {
	logger, err := newLogger(cfg.LogLevel)
	if err != nil {
		return nil, err
	}

	database, err := db.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return nil, err
	}

	repo := db.NewRepository(database)
	return &App{
		Config:     cfg,
		Logger:     logger,
		DB:         database,
		Repository: repo,
		Auth:       auth.NewService(repo),
	}, nil
}

// initSessions wires session orchestration dependencies for serve mode.
func (a *App) initSessions() error {
	if a.Sessions != nil {
		return nil
	}

	channels, err := browser.NewRegistry(a.Config)
	if err != nil {
		return fmt.Errorf("browser channel registry: %w", err)
	}

	overlayClient, err := overlay.NewClient(a.Config)
	if err != nil {
		return fmt.Errorf("overlay client: %w", err)
	}

	browserSupervisor, err := supervisor.NewBrowser(a.Config, systemd.NewExecRunner())
	if err != nil {
		return fmt.Errorf("browser supervisor: %w", err)
	}

	a.Sessions = session.NewService(a.Config, a.Repository, overlayClient, browserSupervisor, channels, traefik.NoopReconciler{})
	return nil
}

// Migrate runs pending embedded SQL migrations.
func (a *App) Migrate(ctx context.Context) error {
	if err := a.DB.Migrate(ctx); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	a.Logger.Info("database migrations applied")
	return nil
}

// Serve starts the HTTP API until the context is canceled.
func (a *App) Serve(ctx context.Context) error {
	if err := a.initSessions(); err != nil {
		return err
	}
	if err := a.Migrate(ctx); err != nil {
		return err
	}
	if err := a.Sessions.ReconcileStartup(ctx); err != nil {
		return fmt.Errorf("reconcile sessions: %w", err)
	}

	monitor := session.NewMonitor(a.Sessions, a.Logger)
	monitorCtx, cancelMonitor := context.WithCancel(ctx)
	defer cancelMonitor()
	go monitor.Run(monitorCtx)

	server := &httpapi.Server{Auth: a.Auth, Sessions: a.Sessions}
	router := httpapi.NewRouter(a.Logger, server)
	httpServer := &http.Server{
		Addr:    a.Config.ListenAddress,
		Handler: router,
	}

	errCh := make(chan error, 1)
	go func() {
		a.Logger.Info("http server listening", zap.String("addr", a.Config.ListenAddress))
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := httpServer.Shutdown(shutdownCtx); err != nil {
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

// Close releases app resources.
func (a *App) Close() error {
	var closeErr error
	if a.DB != nil {
		if err := a.DB.Close(); err != nil {
			closeErr = err
		}
	}
	if a.Logger != nil {
		if err := a.Logger.Sync(); err != nil {
			closeErr = err
		}
	}
	return closeErr
}

func newLogger(level string) (*zap.Logger, error) {
	cfg := zap.NewProductionConfig()
	if err := cfg.Level.UnmarshalText([]byte(level)); err != nil {
		return nil, fmt.Errorf("parse log level: %w", err)
	}
	return cfg.Build()
}
