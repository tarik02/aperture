package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/aperture/aperture/internal/metrics"
	"github.com/aperture/aperture/internal/session"
	"github.com/aperture/aperture/internal/version"
	"go.uber.org/zap"
)

const metricsShutdownTimeout = 5 * time.Second

// initMetrics wires Prometheus instruments into the services, or returns nil
// when metrics_address is unset.
func (a *App) initMetrics() (*metrics.Metrics, error) {
	if a.Config.MetricsAddress == "" {
		return nil, nil
	}
	build := version.Get()
	appMetrics := metrics.New(metrics.BuildInfo{
		Version: build.Version,
		Commit:  build.Commit,
		Color:   a.Config.DeployColor,
	})
	if err := appMetrics.Register(
		metrics.NewStateCollector(a.Config, a.Repository, a.Logger),
		session.NewWrapperCollector(a.Sessions, appMetrics, a.Logger),
	); err != nil {
		return nil, fmt.Errorf("register metrics collectors: %w", err)
	}
	a.Sessions.SetMetrics(appMetrics)
	a.Promotion.SetMetrics(appMetrics)
	a.GC.SetMetrics(appMetrics)
	return appMetrics, nil
}

// serveMetricsWhileActive binds metrics_address only while this color is the
// active one. Both colors read the same config, and during a rollout the
// candidate takes the address within a role poll after the old color releases
// it, so one scrape target always reaches the daemon that owns the sessions.
func (a *App) serveMetricsWhileActive(ctx context.Context, handler http.Handler) {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", handler)

	var server *http.Server
	bindFailing := false
	stop := func() {
		if server == nil {
			return
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), metricsShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			a.Logger.Warn("shutdown metrics server", zap.Error(err))
		}
		server = nil
	}
	defer stop()

	ticker := time.NewTicker(deployRolePollInterval)
	defer ticker.Stop()
	for {
		active, err := a.deployColorActive()
		if err != nil {
			a.Logger.Error("check deployment role for metrics", zap.Error(err))
		} else if !active && server != nil {
			stop()
			a.Logger.Info("metrics server released on inactive api", zap.String("color", a.Config.DeployColor))
		} else if active && server == nil {
			listener, err := net.Listen("tcp", a.Config.MetricsAddress)
			if err != nil {
				// The previous active color holds the address until it notices the switch.
				if !bindFailing {
					a.Logger.Warn("metrics address unavailable, retrying", zap.String("addr", a.Config.MetricsAddress), zap.Error(err))
				}
				bindFailing = true
			} else {
				bindFailing = false
				server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
				go a.runMetricsServer(server, listener)
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *App) runMetricsServer(server *http.Server, listener net.Listener) {
	a.Logger.Info("metrics server listening", zap.String("addr", listener.Addr().String()))
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		a.Logger.Error("metrics server", zap.Error(err))
	}
}
