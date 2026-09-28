package session

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Sources of per-session resource usage.
const (
	resourceSourceCgroup      = "cgroup"
	resourceSourceProcessTree = "process_tree"
)

const cgroupRoot = "/sys/fs/cgroup"

// userHZ is the unit of the CPU times in /proc/<pid>/stat. Linux fixes it at
// 100 for userspace on every architecture, independent of the kernel's HZ.
const userHZ = 100

// sessionResources is one session's resource usage. Optional values are nil
// when the source cannot report them.
type sessionResources struct {
	source          string
	cpuSeconds      float64
	memoryBytes     float64
	memoryPeakBytes *float64
	swapBytes       *float64
	tasks           float64
	ioReadBytes     *float64
	ioWriteBytes    *float64
}

// readSessionResources reads the usage of the session whose wrapper runs as
// pid. A session in a cgroup of its own, as a systemd unit is, reads the
// cgroup; a session sharing the daemon's cgroup, as with the direct
// supervisor in a container, sums the wrapper's process tree.
func readSessionResources(sessionID string, pid int, processes func() (processTable, error)) (sessionResources, error) {
	cgroupPath, err := processCgroup(pid)
	if err != nil {
		return sessionResources{source: resourceSourceCgroup}, err
	}
	if cgroupPath != "" && strings.Contains(filepath.Base(cgroupPath), sessionID) {
		resources, err := readCgroupResources(filepath.Join(cgroupRoot, cgroupPath))
		resources.source = resourceSourceCgroup
		return resources, err
	}
	table, err := processes()
	if err != nil {
		return sessionResources{source: resourceSourceProcessTree}, err
	}
	resources, err := table.readTreeResources(pid)
	resources.source = resourceSourceProcessTree
	return resources, err
}

// processCgroup returns the cgroup v2 path of pid, relative to the cgroup
// root, or an empty path on a host without cgroup v2.
func processCgroup(pid int) (string, error) {
	body, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		if path, ok := strings.CutPrefix(line, "0::"); ok {
			return path, nil
		}
	}
	// Only cgroup v1 hierarchies: the process tree is the only source.
	return "", nil
}

func readCgroupResources(dir string) (sessionResources, error) {
	var resources sessionResources
	cpuStat, err := readKeyedValues(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return resources, err
	}
	resources.cpuSeconds = cpuStat["usage_usec"] / 1e6
	if resources.memoryBytes, err = readCgroupValue(filepath.Join(dir, "memory.current")); err != nil {
		return resources, err
	}
	if resources.tasks, err = readCgroupValue(filepath.Join(dir, "pids.current")); err != nil {
		return resources, err
	}
	if resources.memoryPeakBytes, err = readOptionalCgroupValue(filepath.Join(dir, "memory.peak")); err != nil {
		return resources, err
	}
	if resources.swapBytes, err = readOptionalCgroupValue(filepath.Join(dir, "memory.swap.current")); err != nil {
		return resources, err
	}
	resources.ioReadBytes, resources.ioWriteBytes, err = readCgroupIO(filepath.Join(dir, "io.stat"))
	return resources, err
}

func readCgroupValue(path string) (float64, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(string(body)), 64)
}

// readOptionalCgroupValue reads a file that older kernels or disabled
// controllers leave out.
func readOptionalCgroupValue(path string) (*float64, error) {
	value, err := readCgroupValue(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// readCgroupIO sums the bytes of every device in io.stat. A cgroup without
// the io controller has no io.stat.
func readCgroupIO(path string) (*float64, *float64, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var read, written float64
	for _, line := range strings.Split(string(body), "\n") {
		for _, field := range strings.Fields(line) {
			key, value, ok := strings.Cut(field, "=")
			if !ok {
				continue
			}
			number, err := strconv.ParseFloat(value, 64)
			if err != nil {
				continue
			}
			switch key {
			case "rbytes":
				read += number
			case "wbytes":
				written += number
			}
		}
	}
	return &read, &written, nil
}

// readKeyedValues parses "key value" lines as cpu.stat, /proc/<pid>/io and
// smaps_rollup use them; a trailing colon and unit after the key are ignored.
func readKeyedValues(path string) (map[string]float64, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	values := map[string]float64{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			continue
		}
		values[strings.TrimSuffix(fields[0], ":")] = value
	}
	return values, scanner.Err()
}

type processStat struct {
	parent  int
	cpuTime float64
	threads float64
}

// processTable is one pass over /proc, shared by every session of a poll.
type processTable struct {
	stats    map[int]processStat
	children map[int][]int
}

func readProcessTable() (processTable, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return processTable{}, err
	}
	table := processTable{stats: map[int]processStat{}, children: map[int][]int{}}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := readProcessStat(pid)
		if err != nil {
			// The process exited during the scan.
			continue
		}
		table.stats[pid] = stat
		table.children[stat.parent] = append(table.children[stat.parent], pid)
	}
	return table, nil
}

func readProcessStat(pid int) (processStat, error) {
	body, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return processStat{}, err
	}
	// The command name may contain spaces and parentheses, so fields are
	// counted from the last closing parenthesis.
	end := bytes.LastIndexByte(body, ')')
	if end < 0 {
		return processStat{}, errors.New("malformed process stat")
	}
	fields := strings.Fields(string(body[end+1:]))
	// fields[0] is the state (stat field 3), so stat field n is fields[n-3].
	if len(fields) < 18 {
		return processStat{}, errors.New("short process stat")
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return processStat{}, err
	}
	var ticks float64
	// utime, stime, and the cutime and cstime of reaped children.
	for _, index := range []int{11, 12, 13, 14} {
		value, err := strconv.ParseFloat(fields[index], 64)
		if err != nil {
			return processStat{}, err
		}
		ticks += value
	}
	threads, err := strconv.ParseFloat(fields[17], 64)
	if err != nil {
		return processStat{}, err
	}
	return processStat{parent: parent, cpuTime: ticks / userHZ, threads: threads}, nil
}

// readTreeResources sums root and its descendants. Memory is the proportional
// set size, so pages the processes share are counted once. CPU time and I/O
// include children the tree already reaped.
func (t processTable) readTreeResources(root int) (sessionResources, error) {
	if _, ok := t.stats[root]; !ok {
		return sessionResources{}, fmt.Errorf("wrapper process %d not found", root)
	}
	var resources sessionResources
	var swap, read, written float64
	pending := []int{root}
	for len(pending) > 0 {
		pid := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		pending = append(pending, t.children[pid]...)

		stat := t.stats[pid]
		resources.cpuSeconds += stat.cpuTime
		resources.tasks += stat.threads

		memory, err := readKeyedValues(fmt.Sprintf("/proc/%d/smaps_rollup", pid))
		if processGone(err) {
			continue
		}
		if err != nil {
			return resources, err
		}
		resources.memoryBytes += memory["Pss"] * 1024
		swap += memory["SwapPss"] * 1024

		counters, err := readKeyedValues(fmt.Sprintf("/proc/%d/io", pid))
		if processGone(err) {
			continue
		}
		if err != nil {
			return resources, err
		}
		read += counters["read_bytes"]
		written += counters["write_bytes"]
	}
	resources.swapBytes = &swap
	resources.ioReadBytes = &read
	resources.ioWriteBytes = &written
	return resources, nil
}

// processGone reports a read that failed because the process exited after
// the table was built.
func processGone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, unix.ESRCH)
}
