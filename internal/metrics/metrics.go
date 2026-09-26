// Package metrics holds Aperture's Prometheus instruments. A nil *Metrics is
// valid and records nothing, so services work unchanged when metrics are off.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const namespace = "aperture"

// Session lifecycle events counted by aperture_session_events_total.
const (
	SessionCreated   = "created"
	SessionStarted   = "started"
	SessionSuspended = "suspended"
	SessionWoken     = "woken"
	SessionReopened  = "reopened"
	SessionDeleted   = "deleted"
	SessionExpired   = "expired"
	SessionFailed    = "failed"
)

// Browser start kinds observed by aperture_session_start_duration_seconds.
const (
	StartCreate = "create"
	StartReopen = "reopen"
	StartWake   = "wake"
)

// BuildInfo labels aperture_build_info.
type BuildInfo struct {
	Version string
	Commit  string
	Color   string
}

// Metrics owns a private registry and the instruments the daemon records into.
type Metrics struct {
	registry *prometheus.Registry

	httpRequests *prometheus.CounterVec
	httpDuration *prometheus.HistogramVec
	httpInFlight prometheus.Gauge
	apiErrors    *prometheus.CounterVec

	sessionEvents        *prometheus.CounterVec
	sessionStartDuration *prometheus.HistogramVec

	promotions        *prometheus.CounterVec
	promotionDuration prometheus.Histogram

	gcRuns          *prometheus.CounterVec
	gcDuration      prometheus.Histogram
	gcRemoved       *prometheus.CounterVec
	gcStagingErrors prometheus.Counter

	authLogins   *prometheus.CounterVec
	authFailures *prometheus.CounterVec

	uploadedFiles  prometheus.Counter
	uploadedBytes  prometheus.Counter
	uploadFailures prometheus.Counter
}

// New builds the instruments and registers them with Go runtime and process
// collectors on a registry of their own.
func New(build BuildInfo) *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		httpRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "http_requests_total",
			Help:      "HTTP requests served by the API listener, by gin route template.",
		}, []string{"route", "method", "status_class"}),
		httpDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request latency on the API listener, by gin route template.",
			Buckets:   []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60},
		}, []string{"route", "method"}),
		httpInFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Name:      "http_requests_in_flight",
			Help:      "HTTP requests currently served by the API listener.",
		}),
		apiErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "api_errors_total",
			Help:      "API error responses by error code.",
		}, []string{"code"}),
		sessionEvents: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "session_events_total",
			Help:      "Session lifecycle transitions.",
		}, []string{"event"}),
		sessionStartDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "session_start_duration_seconds",
			Help:      "Time until a started browser answers CDP, by start kind.",
			Buckets:   []float64{0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 60},
		}, []string{"kind"}),
		promotions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "snapshot_promotions_total",
			Help:      "Session promotions into snapshots by result.",
		}, []string{"result"}),
		promotionDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "snapshot_promotion_duration_seconds",
			Help:      "Duration of successful session promotions.",
			Buckets:   []float64{0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300},
		}),
		gcRuns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "gc_runs_total",
			Help:      "Garbage collection runs by result.",
		}, []string{"result"}),
		gcDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Name:      "gc_run_duration_seconds",
			Help:      "Duration of garbage collection runs.",
			Buckets:   []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300},
		}),
		gcRemoved: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "gc_removed_total",
			Help:      "Items garbage collection removed, by kind.",
		}, []string{"kind"}),
		gcStagingErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "gc_staging_sweep_errors_total",
			Help:      "Session upload staging directories garbage collection could not sweep.",
		}),
		authLogins: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "auth_logins_total",
			Help:      "Successful web logins by method.",
		}, []string{"method"}),
		authFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "auth_failures_total",
			Help:      "Rejected logins and request authentications by method and error code.",
		}, []string{"method", "reason"}),
		uploadedFiles: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "session_uploads_total",
			Help:      "Files uploaded into sessions through the API or a live session.",
		}),
		uploadedBytes: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "session_upload_bytes_total",
			Help:      "Bytes uploaded into sessions through the API or a live session.",
		}),
		uploadFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "session_upload_failures_total",
			Help:      "Session upload requests that were rejected or failed.",
		}),
	}

	buildInfo := prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace:   namespace,
		Name:        "build_info",
		Help:        "Build of the daemon serving metrics; always 1.",
		ConstLabels: prometheus.Labels{"version": build.Version, "commit": build.Commit, "color": build.Color},
	})
	buildInfo.Set(1)

	m.registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		buildInfo,
		m.httpRequests,
		m.httpDuration,
		m.httpInFlight,
		m.apiErrors,
		m.sessionEvents,
		m.sessionStartDuration,
		m.promotions,
		m.promotionDuration,
		m.gcRuns,
		m.gcDuration,
		m.gcRemoved,
		m.gcStagingErrors,
		m.authLogins,
		m.authFailures,
		m.uploadedFiles,
		m.uploadedBytes,
		m.uploadFailures,
	)
	return m
}

// Register adds collectors that read their values on scrape.
func (m *Metrics) Register(collectors ...prometheus.Collector) error {
	for _, collector := range collectors {
		if err := m.registry.Register(collector); err != nil {
			return err
		}
	}
	return nil
}

// Handler serves the registry in the Prometheus exposition format.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{Registry: m.registry})
}

// RequestStarted tracks one in-flight API request until the returned func runs.
func (m *Metrics) RequestStarted() func() {
	if m == nil {
		return func() {}
	}
	m.httpInFlight.Inc()
	return m.httpInFlight.Dec
}

// ObserveRequest records a finished API request. errorCode is the API error
// code of the response, or empty.
func (m *Metrics) ObserveRequest(route, method string, status int, duration time.Duration, errorCode string) {
	if m == nil {
		return
	}
	method = knownMethod(method)
	m.httpRequests.WithLabelValues(route, method, statusClass(status)).Inc()
	m.httpDuration.WithLabelValues(route, method).Observe(duration.Seconds())
	if errorCode != "" {
		m.apiErrors.WithLabelValues(errorCode).Inc()
	}
}

// knownMethod folds client-chosen method names into one label value so they
// cannot grow the series count.
func knownMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

func statusClass(status int) string {
	if status < 100 || status > 599 {
		return "other"
	}
	return strconv.Itoa(status/100) + "xx"
}

// SessionEvent counts one session lifecycle transition.
func (m *Metrics) SessionEvent(event string) {
	if m == nil {
		return
	}
	m.sessionEvents.WithLabelValues(event).Inc()
}

// SessionStarted counts a browser that reached running and records how long it took.
func (m *Metrics) SessionStarted(kind, event string, duration time.Duration) {
	if m == nil {
		return
	}
	m.sessionEvents.WithLabelValues(event).Inc()
	m.sessionStartDuration.WithLabelValues(kind).Observe(duration.Seconds())
}

// Promotion records a finished session promotion.
func (m *Metrics) Promotion(duration time.Duration, err error) {
	if m == nil {
		return
	}
	if err != nil {
		m.promotions.WithLabelValues("failed").Inc()
		return
	}
	m.promotions.WithLabelValues("succeeded").Inc()
	m.promotionDuration.Observe(duration.Seconds())
}

// GCRemoved lists what one garbage collection run removed.
type GCRemoved struct {
	ExpiredSessions    int
	RemovedArtifacts   int
	CollectedSnapshots int
	StagingSweepErrors int
}

// GCRun records a finished garbage collection run.
func (m *Metrics) GCRun(duration time.Duration, removed GCRemoved, err error) {
	if m == nil {
		return
	}
	m.gcDuration.Observe(duration.Seconds())
	if err != nil {
		m.gcRuns.WithLabelValues("failed").Inc()
	} else {
		m.gcRuns.WithLabelValues("succeeded").Inc()
	}
	m.sessionEvents.WithLabelValues(SessionExpired).Add(float64(removed.ExpiredSessions))
	m.gcRemoved.WithLabelValues("session").Add(float64(removed.ExpiredSessions))
	m.gcRemoved.WithLabelValues("artifacts").Add(float64(removed.RemovedArtifacts))
	m.gcRemoved.WithLabelValues("snapshot").Add(float64(removed.CollectedSnapshots))
	m.gcStagingErrors.Add(float64(removed.StagingSweepErrors))
}

// Login counts a successful web login.
func (m *Metrics) Login(method string) {
	if m == nil {
		return
	}
	m.authLogins.WithLabelValues(method).Inc()
}

// AuthFailure counts a rejected login or request authentication. reason is
// the API error code, never a user or credential detail.
func (m *Metrics) AuthFailure(method, reason string) {
	if m == nil {
		return
	}
	m.authFailures.WithLabelValues(method, reason).Inc()
}

// SessionUploads adds uploaded files, their bytes, and failed upload requests.
func (m *Metrics) SessionUploads(files, bytes, failures float64) {
	if m == nil {
		return
	}
	m.uploadedFiles.Add(files)
	m.uploadedBytes.Add(bytes)
	m.uploadFailures.Add(failures)
}
