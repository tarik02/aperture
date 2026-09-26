package browser

import (
	"net/http"
	"sync/atomic"
)

// WrapperStats reports live session counters for daemon metrics. Totals count
// from StartedAt, the wrapper process start, so a changed StartedAt tells the
// daemon the totals restarted from zero.
type WrapperStats struct {
	StartedAt           int64                `json:"startedAt"`
	Clients             []WrapperClientCount `json:"clients"`
	MediaViewers        map[string]int       `json:"mediaViewers"`
	CDPConnections      int                  `json:"cdpConnections"`
	RecordingsActive    int                  `json:"recordingsActive"`
	RecordingsStarted   uint64               `json:"recordingsStarted"`
	RecordingFailures   map[string]uint64    `json:"recordingFailures"`
	UploadedFiles       uint64               `json:"uploadedFiles"`
	UploadedBytes       uint64               `json:"uploadedBytes"`
	UploadFailures      uint64               `json:"uploadFailures"`
	Proxy               *WrapperProxyStats   `json:"proxy,omitempty"`
	LocalTunnelAttached bool                 `json:"localTunnelAttached"`
}

// WrapperClientCount counts connected live session clients with one role and transport.
type WrapperClientCount struct {
	Role      string `json:"role"`
	Transport string `json:"transport"`
	Count     int    `json:"count"`
}

// WrapperProxyStats reports the session-local SOCKS proxy counters.
type WrapperProxyStats struct {
	ActiveConns int64  `json:"activeConns"`
	TotalConns  uint64 `json:"totalConns"`
	FailedConns uint64 `json:"failedConns"`
}

type wrapperUploadCounters struct {
	files    atomic.Uint64
	bytes    atomic.Uint64
	failures atomic.Uint64
}

func (r *wrapperRuntime) handleStats(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !r.wrapperControlAuthorized(req) {
		writeWrapperError(w, http.StatusUnauthorized, "wrapper control token required")
		return
	}
	writeWrapperJSON(w, http.StatusOK, r.stats())
}

func (r *wrapperRuntime) stats() WrapperStats {
	stats := WrapperStats{
		StartedAt:         r.startedAt.UnixNano(),
		MediaViewers:      map[string]int{},
		RecordingFailures: map[string]uint64{},
		UploadedFiles:     r.uploads.files.Load(),
		UploadedBytes:     r.uploads.bytes.Load(),
		UploadFailures:    r.uploads.failures.Load(),
	}

	r.mu.Lock()
	for viewer := range r.viewers {
		stats.MediaViewers[viewer.role]++
	}
	stats.CDPConnections = r.cdpConnections
	liveSession := r.liveSession
	if liveSession != nil {
		for _, recording := range liveSession.recordings {
			liveSession.refreshRecordingLocked(recording)
			stats.RecordingsStarted++
			switch recording.Status {
			case wrapperRecordingStarting, wrapperRecordingRunning:
				stats.RecordingsActive++
			case wrapperRecordingFailed:
				stats.RecordingFailures[recording.StopReason]++
			}
		}
	}
	proxyManager := r.proxyManager
	r.mu.Unlock()

	if proxyManager != nil {
		proxyStats := proxyManager.Stats()
		stats.Proxy = &WrapperProxyStats{
			ActiveConns: proxyStats.ActiveConns,
			TotalConns:  proxyStats.TotalConns,
			FailedConns: proxyStats.FailedConns,
		}
		stats.LocalTunnelAttached = proxyStats.LocalTunnelAttached
	}
	if liveSession != nil {
		stats.Clients = liveSession.clientCounts()
	}
	return stats
}

func (session *liveSession) clientCounts() []WrapperClientCount {
	session.mu.Lock()
	clients := make([]*liveSessionClient, 0, len(session.clients))
	for _, client := range session.clients {
		clients = append(clients, client)
	}
	session.mu.Unlock()

	type key struct {
		role      string
		transport string
	}
	counts := map[key]int{}
	for _, client := range clients {
		// A client between transports is recovering and keeps its seat.
		transport := "none"
		if active := client.transport(); active != nil {
			transport = active.kind()
		}
		counts[key{role: client.role, transport: transport}]++
	}
	result := make([]WrapperClientCount, 0, len(counts))
	for k, count := range counts {
		result = append(result, WrapperClientCount{Role: k.role, Transport: k.transport, Count: count})
	}
	return result
}
