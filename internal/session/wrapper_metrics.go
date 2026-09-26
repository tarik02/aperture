package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/aperture/aperture/internal/browser"
	"github.com/aperture/aperture/internal/db"
	"github.com/aperture/aperture/internal/metrics"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
)

const (
	wrapperStatsRequestTimeout = time.Second
	// wrapperStatsPollTimeout bounds one poll of every wrapper, so a scrape
	// never waits on more than this however many sessions run.
	wrapperStatsPollTimeout = 5 * time.Second
	wrapperStatsConcurrency = 16
	// wrapperStatsMaxAge lets scrapes from redundant Prometheus servers share one poll.
	wrapperStatsMaxAge = 5 * time.Second
)

// wrapperTotals holds the cumulative counters one wrapper reported last.
type wrapperTotals struct {
	startedAt         int64
	recordingsStarted uint64
	recordingFailures map[string]uint64
	uploadedFiles     uint64
	uploadedBytes     uint64
	uploadFailures    uint64
	proxyConns        uint64
	proxyFailures     uint64
	// Highest resource counters reported for this wrapper, so a process-tree
	// sum that drops when a process is reaped outside the tree never makes a
	// counter go backwards.
	cpuSeconds   float64
	ioReadBytes  float64
	ioWriteBytes float64
}

// WrapperCollector polls the stats endpoint of every running session wrapper
// on scrape and exports the sums; only the optional resource usage carries a
// session ID, and only for running sessions. Wrapper totals
// restart with each wrapper process and vanish with its session, so the
// daemon adds the growth it observes to counters of its own; growth between a
// wrapper's last poll and its exit is not counted.
type WrapperCollector struct {
	service *Service
	metrics *metrics.Metrics
	logger  *zap.Logger
	client  *http.Client

	perSession bool

	mu        sync.Mutex
	polledAt  time.Time
	seen      map[string]wrapperTotals
	resources map[string]sessionResources

	wrappers          *prometheus.GaugeVec
	clients           *prometheus.GaugeVec
	mediaViewers      *prometheus.GaugeVec
	cdpConnections    prometheus.Gauge
	recordingsActive  prometheus.Gauge
	proxyConnsActive  prometheus.Gauge
	localTunnels      prometheus.Gauge
	pollDuration      prometheus.Gauge
	recordingsStarted prometheus.Counter
	recordingFailures *prometheus.CounterVec
	proxyConns        prometheus.Counter
	proxyFailures     prometheus.Counter
	pollErrors        prometheus.Counter

	resourceSessions *prometheus.GaugeVec
	resourceErrors   *prometheus.CounterVec
	sessionCPU       *prometheus.Desc
	sessionMemory    *prometheus.Desc
	sessionPeak      *prometheus.Desc
	sessionSwap      *prometheus.Desc
	sessionTasks     *prometheus.Desc
	sessionIORead    *prometheus.Desc
	sessionIOWrite   *prometheus.Desc
}

// NewWrapperCollector builds a collector over service's running sessions. Upload
// totals go to m, which also counts uploads through the API. perSession adds
// resource usage labeled with the session ID of every running session.
func NewWrapperCollector(service *Service, m *metrics.Metrics, perSession bool, logger *zap.Logger) *WrapperCollector {
	sessionDesc := func(name, help string) *prometheus.Desc {
		return prometheus.NewDesc(prometheus.BuildFQName("aperture", "session", name), help, []string{"session_id"}, nil)
	}
	gauge := func(name, help string) prometheus.Gauge {
		return prometheus.NewGauge(prometheus.GaugeOpts{Namespace: "aperture", Name: name, Help: help})
	}
	counter := func(name, help string) prometheus.Counter {
		return prometheus.NewCounter(prometheus.CounterOpts{Namespace: "aperture", Name: name, Help: help})
	}
	return &WrapperCollector{
		service:    service,
		metrics:    m,
		logger:     logger,
		client:     &http.Client{Timeout: wrapperStatsRequestTimeout},
		seen:       map[string]wrapperTotals{},
		perSession: perSession,
		wrappers: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "aperture",
			Name:      "session_wrappers",
			Help:      "Wrappers of running sessions by whether the last poll reached them.",
		}, []string{"state"}),
		clients: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "aperture",
			Name:      "live_session_clients",
			Help:      "Connected live session clients by role and transport; none means reconnecting.",
		}, []string{"role", "transport"}),
		mediaViewers: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "aperture",
			Name:      "media_viewers",
			Help:      "Connected WebRTC media viewers by role.",
		}, []string{"role"}),
		cdpConnections:    gauge("cdp_connections", "Open CDP connections proxied by session wrappers."),
		recordingsActive:  gauge("recordings_active", "Recordings currently starting or running."),
		proxyConnsActive:  gauge("proxy_connections_active", "Connections the session SOCKS proxies currently relay."),
		localTunnels:      gauge("local_tunnels_attached", "Sessions with a local tunnel client attached."),
		pollDuration:      gauge("session_wrapper_poll_duration_seconds", "Duration of the last poll of every session wrapper."),
		recordingsStarted: counter("recordings_started_total", "Recordings started."),
		recordingFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "aperture",
			Name:      "recording_failures_total",
			Help:      "Recordings that failed, by stop reason.",
		}, []string{"reason"}),
		proxyConns:    counter("proxy_connections_total", "Connections accepted by the session SOCKS proxies."),
		proxyFailures: counter("proxy_connection_failures_total", "Session SOCKS proxy connections that failed before relaying."),
		pollErrors:    counter("session_wrapper_poll_errors_total", "Wrapper stats requests that failed."),
		resourceSessions: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "aperture",
			Name:      "session_resource_sessions",
			Help:      "Running sessions whose resource usage the last poll read, by source.",
		}, []string{"source"}),
		resourceErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "aperture",
			Name:      "session_resource_errors_total",
			Help:      "Session resource reads that failed, by source.",
		}, []string{"source"}),
		sessionCPU:     sessionDesc("cpu_seconds_total", "CPU time the session's processes used."),
		sessionMemory:  sessionDesc("memory_bytes", "Memory of the session: memory.current of its cgroup, or the summed proportional set size of its processes."),
		sessionPeak:    sessionDesc("memory_peak_bytes", "Highest memory.current of the session's cgroup."),
		sessionSwap:    sessionDesc("swap_bytes", "Swap the session's processes use."),
		sessionTasks:   sessionDesc("tasks", "Processes and threads of the session."),
		sessionIORead:  sessionDesc("io_read_bytes_total", "Bytes the session's processes read from block devices."),
		sessionIOWrite: sessionDesc("io_write_bytes_total", "Bytes the session's processes wrote to block devices."),
	}
}

func (c *WrapperCollector) collectors() []prometheus.Collector {
	return []prometheus.Collector{
		c.wrappers,
		c.clients,
		c.mediaViewers,
		c.cdpConnections,
		c.recordingsActive,
		c.proxyConnsActive,
		c.localTunnels,
		c.pollDuration,
		c.recordingsStarted,
		c.recordingFailures,
		c.proxyConns,
		c.proxyFailures,
		c.pollErrors,
		c.resourceSessions,
		c.resourceErrors,
	}
}

// Describe implements prometheus.Collector.
func (c *WrapperCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, collector := range c.collectors() {
		collector.Describe(ch)
	}
	for _, desc := range []*prometheus.Desc{
		c.sessionCPU, c.sessionMemory, c.sessionPeak, c.sessionSwap,
		c.sessionTasks, c.sessionIORead, c.sessionIOWrite,
	} {
		ch <- desc
	}
}

// Collect implements prometheus.Collector.
func (c *WrapperCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.polledAt) >= wrapperStatsMaxAge {
		c.poll()
	}
	for _, collector := range c.collectors() {
		collector.Collect(ch)
	}
	for sessionID, resources := range c.resources {
		ch <- prometheus.MustNewConstMetric(c.sessionCPU, prometheus.CounterValue, resources.cpuSeconds, sessionID)
		ch <- prometheus.MustNewConstMetric(c.sessionMemory, prometheus.GaugeValue, resources.memoryBytes, sessionID)
		ch <- prometheus.MustNewConstMetric(c.sessionTasks, prometheus.GaugeValue, resources.tasks, sessionID)
		if resources.memoryPeakBytes != nil {
			ch <- prometheus.MustNewConstMetric(c.sessionPeak, prometheus.GaugeValue, *resources.memoryPeakBytes, sessionID)
		}
		if resources.swapBytes != nil {
			ch <- prometheus.MustNewConstMetric(c.sessionSwap, prometheus.GaugeValue, *resources.swapBytes, sessionID)
		}
		if resources.ioReadBytes != nil {
			ch <- prometheus.MustNewConstMetric(c.sessionIORead, prometheus.CounterValue, *resources.ioReadBytes, sessionID)
		}
		if resources.ioWriteBytes != nil {
			ch <- prometheus.MustNewConstMetric(c.sessionIOWrite, prometheus.CounterValue, *resources.ioWriteBytes, sessionID)
		}
	}
}

type wrapperPoll struct {
	sessionID   string
	stats       browser.WrapperStats
	err         error
	resources   sessionResources
	resourceErr error
}

func (c *WrapperCollector) poll() {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), wrapperStatsPollTimeout)
	defer cancel()

	sessions, err := c.service.repo.ListSessionsByStatus(ctx, db.SessionStatusRunning)
	if err != nil {
		c.pollErrors.Inc()
		c.logger.Warn("list running sessions for wrapper metrics", zap.Error(err))
		return
	}

	polls := make([]wrapperPoll, len(sessions))
	processes := sync.OnceValues(readProcessTable)
	slots := make(chan struct{}, wrapperStatsConcurrency)
	var wg sync.WaitGroup
	for i := range sessions {
		polls[i].sessionID = sessions[i].ID
		wg.Go(func() {
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				polls[i].err = ctx.Err()
				return
			}
			defer func() { <-slots }()
			polls[i].stats, polls[i].err = c.fetch(ctx, &sessions[i])
			if polls[i].err == nil && c.perSession {
				polls[i].resources, polls[i].resourceErr = readSessionResources(sessions[i].ID, polls[i].stats.PID, processes)
			}
		})
	}
	wg.Wait()

	c.wrappers.Reset()
	c.clients.Reset()
	c.mediaViewers.Reset()
	c.resourceSessions.Reset()
	resources := make(map[string]sessionResources, len(polls))
	var reachable, unreachable, cdpConnections, recordingsActive, localTunnels int
	var proxyConnsActive int64
	seen := make(map[string]wrapperTotals, len(polls))
	for _, poll := range polls {
		if poll.err != nil {
			unreachable++
			c.pollErrors.Inc()
			c.logger.Debug("poll session wrapper stats", zap.String("sessionId", poll.sessionID), zap.Error(poll.err))
			if previous, ok := c.seen[poll.sessionID]; ok {
				seen[poll.sessionID] = previous
			}
			continue
		}
		reachable++
		stats := poll.stats
		for _, client := range stats.Clients {
			c.clients.WithLabelValues(client.Role, client.Transport).Add(float64(client.Count))
		}
		for role, count := range stats.MediaViewers {
			c.mediaViewers.WithLabelValues(role).Add(float64(count))
		}
		cdpConnections += stats.CDPConnections
		recordingsActive += stats.RecordingsActive
		if stats.LocalTunnelAttached {
			localTunnels++
		}

		totals := wrapperTotals{
			startedAt:         stats.StartedAt,
			recordingsStarted: stats.RecordingsStarted,
			recordingFailures: stats.RecordingFailures,
			uploadedFiles:     stats.UploadedFiles,
			uploadedBytes:     stats.UploadedBytes,
			uploadFailures:    stats.UploadFailures,
		}
		if stats.Proxy != nil {
			proxyConnsActive += stats.Proxy.ActiveConns
			totals.proxyConns = stats.Proxy.TotalConns
			totals.proxyFailures = stats.Proxy.FailedConns
		}
		previous, ok := c.seen[poll.sessionID]
		if !ok || previous.startedAt != totals.startedAt {
			previous = wrapperTotals{}
		}
		c.recordingsStarted.Add(growth(totals.recordingsStarted, previous.recordingsStarted))
		for reason, count := range totals.recordingFailures {
			c.recordingFailures.WithLabelValues(reason).Add(growth(count, previous.recordingFailures[reason]))
		}
		c.metrics.SessionUploads(
			growth(totals.uploadedFiles, previous.uploadedFiles),
			growth(totals.uploadedBytes, previous.uploadedBytes),
			growth(totals.uploadFailures, previous.uploadFailures),
		)
		c.proxyConns.Add(growth(totals.proxyConns, previous.proxyConns))
		c.proxyFailures.Add(growth(totals.proxyFailures, previous.proxyFailures))
		if c.perSession {
			c.recordResources(poll, previous, &totals, resources)
		}
		seen[poll.sessionID] = totals
	}
	c.seen = seen
	c.resources = resources

	c.wrappers.WithLabelValues("reachable").Set(float64(reachable))
	c.wrappers.WithLabelValues("unreachable").Set(float64(unreachable))
	c.cdpConnections.Set(float64(cdpConnections))
	c.recordingsActive.Set(float64(recordingsActive))
	c.proxyConnsActive.Set(float64(proxyConnsActive))
	c.localTunnels.Set(float64(localTunnels))
	c.pollDuration.Set(time.Since(started).Seconds())
	c.polledAt = time.Now()
}

// growth returns how much a wrapper total rose since the previous poll.
func growth(current, previous uint64) float64 {
	if current < previous {
		return float64(current)
	}
	return float64(current - previous)
}

func (c *WrapperCollector) fetch(ctx context.Context, sessionRow *db.Session) (browser.WrapperStats, error) {
	port, token, err := wrapperControl(sessionRow)
	if err != nil {
		return browser.WrapperStats{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/stats", port), nil)
	if err != nil {
		return browser.WrapperStats{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := c.client.Do(request)
	if err != nil {
		return browser.WrapperStats{}, fmt.Errorf("read wrapper stats: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return browser.WrapperStats{}, fmt.Errorf("read wrapper stats: unexpected status %s", response.Status)
	}
	var stats browser.WrapperStats
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		return browser.WrapperStats{}, fmt.Errorf("decode wrapper stats: %w", err)
	}
	return stats, nil
}

// recordResources keeps the resource usage a poll read for one session and
// raises totals to the session's highest reported counters.
func (c *WrapperCollector) recordResources(poll wrapperPoll, previous wrapperTotals, totals *wrapperTotals, resources map[string]sessionResources) {
	if poll.resourceErr != nil {
		c.resourceErrors.WithLabelValues(poll.resources.source).Inc()
		c.logger.Debug("read session resources",
			zap.String("sessionId", poll.sessionID),
			zap.String("source", poll.resources.source),
			zap.Error(poll.resourceErr),
		)
		totals.cpuSeconds = previous.cpuSeconds
		totals.ioReadBytes = previous.ioReadBytes
		totals.ioWriteBytes = previous.ioWriteBytes
		return
	}
	usage := poll.resources
	usage.cpuSeconds = max(usage.cpuSeconds, previous.cpuSeconds)
	totals.cpuSeconds = usage.cpuSeconds
	if usage.ioReadBytes != nil {
		read := max(*usage.ioReadBytes, previous.ioReadBytes)
		usage.ioReadBytes = &read
		totals.ioReadBytes = read
	}
	if usage.ioWriteBytes != nil {
		written := max(*usage.ioWriteBytes, previous.ioWriteBytes)
		usage.ioWriteBytes = &written
		totals.ioWriteBytes = written
	}
	resources[poll.sessionID] = usage
	c.resourceSessions.WithLabelValues(usage.source).Inc()
}
