package metrics

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
	"golang.org/x/sys/unix"
)

const stateQueryTimeout = 3 * time.Second

var sessionStatuses = []string{
	db.SessionStatusCreating,
	db.SessionStatusRunning,
	db.SessionStatusSuspended,
	db.SessionStatusDeleted,
	db.SessionStatusFailed,
	db.SessionStatusExpired,
}

// StateCollector reads session and snapshot counts from the database and
// storage usage from the filesystem on every scrape.
type StateCollector struct {
	cfg    config.Config
	repo   *db.Repository
	logger *zap.Logger

	sessions       *prometheus.Desc
	snapshots      *prometheus.Desc
	storageSize    *prometheus.Desc
	storageFree    *prometheus.Desc
	databaseSize   *prometheus.Desc
	scrapeFailures *prometheus.CounterVec
}

// NewStateCollector builds a collector for cfg's storage roots and database.
func NewStateCollector(cfg config.Config, repo *db.Repository, logger *zap.Logger) *StateCollector {
	return &StateCollector{
		cfg:    cfg,
		repo:   repo,
		logger: logger,
		sessions: prometheus.NewDesc(
			prometheus.BuildFQName(namespace, "", "sessions"),
			"Sessions by status.",
			[]string{"status"}, nil,
		),
		snapshots: prometheus.NewDesc(
			prometheus.BuildFQName(namespace, "", "snapshots"),
			"Snapshots whose files still exist, by state.",
			[]string{"state"}, nil,
		),
		storageSize: prometheus.NewDesc(
			prometheus.BuildFQName(namespace, "", "storage_size_bytes"),
			"Size of the filesystem holding a storage root.",
			[]string{"root"}, nil,
		),
		storageFree: prometheus.NewDesc(
			prometheus.BuildFQName(namespace, "", "storage_available_bytes"),
			"Bytes available to Aperture on the filesystem holding a storage root.",
			[]string{"root"}, nil,
		),
		databaseSize: prometheus.NewDesc(
			prometheus.BuildFQName(namespace, "", "database_size_bytes"),
			"Size of the SQLite database including its write-ahead log.",
			nil, nil,
		),
		scrapeFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace,
			Name:      "state_scrape_errors_total",
			Help:      "Scrapes that could not read a state source.",
		}, []string{"source"}),
	}
}

// Describe implements prometheus.Collector.
func (c *StateCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.sessions
	ch <- c.snapshots
	ch <- c.storageSize
	ch <- c.storageFree
	ch <- c.databaseSize
	c.scrapeFailures.Describe(ch)
}

// Collect implements prometheus.Collector.
func (c *StateCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), stateQueryTimeout)
	defer cancel()

	c.collectSessions(ctx, ch)
	c.collectSnapshots(ctx, ch)
	c.collectStorage(ch)
	c.collectDatabase(ch)
	c.scrapeFailures.Collect(ch)
}

func (c *StateCollector) collectSessions(ctx context.Context, ch chan<- prometheus.Metric) {
	counts, err := c.repo.CountSessionsByStatus(ctx)
	if err != nil {
		c.failed("sessions", err)
		return
	}
	for _, status := range sessionStatuses {
		ch <- prometheus.MustNewConstMetric(c.sessions, prometheus.GaugeValue, float64(counts[status]), status)
	}
}

func (c *StateCollector) collectSnapshots(ctx context.Context, ch chan<- prometheus.Metric) {
	counts, err := c.repo.CountSnapshots(ctx)
	if err != nil {
		c.failed("snapshots", err)
		return
	}
	ch <- prometheus.MustNewConstMetric(c.snapshots, prometheus.GaugeValue, float64(counts.Active), "active")
	ch <- prometheus.MustNewConstMetric(c.snapshots, prometheus.GaugeValue, float64(counts.Deleted), "deleted")
}

func (c *StateCollector) collectStorage(ch chan<- prometheus.Metric) {
	for _, root := range []struct {
		name string
		path string
	}{
		{"store", c.cfg.StoreRoot},
		{"cold", c.cfg.ColdRoot},
		{"database", filepath.Dir(c.cfg.DatabasePath)},
	} {
		var stat unix.Statfs_t
		if err := unix.Statfs(root.path, &stat); err != nil {
			c.failed("storage_"+root.name, err)
			continue
		}
		blockSize := float64(stat.Bsize)
		ch <- prometheus.MustNewConstMetric(c.storageSize, prometheus.GaugeValue, float64(stat.Blocks)*blockSize, root.name)
		ch <- prometheus.MustNewConstMetric(c.storageFree, prometheus.GaugeValue, float64(stat.Bavail)*blockSize, root.name)
	}
}

func (c *StateCollector) collectDatabase(ch chan<- prometheus.Metric) {
	var size int64
	for _, path := range []string{c.cfg.DatabasePath, c.cfg.DatabasePath + "-wal"} {
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			c.failed("database", err)
			return
		}
		size += info.Size()
	}
	ch <- prometheus.MustNewConstMetric(c.databaseSize, prometheus.GaugeValue, float64(size))
}

func (c *StateCollector) failed(source string, err error) {
	c.scrapeFailures.WithLabelValues(source).Inc()
	c.logger.Warn("metrics state scrape failed", zap.String("source", source), zap.Error(err))
}
