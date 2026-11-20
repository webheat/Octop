package bootstrap

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// serveRangeBytes answers a range request like a release server does. It
// understands both an open range ("bytes=100-") and a closed one
// ("bytes=100-199").
func serveRangeBytes(data []byte, w http.ResponseWriter, r *http.Request) {
	header := r.Header.Get("Range")
	if header == "" {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		w.Write(data)
		return
	}
	var start, end int
	switch {
	case strings.Contains(header, "-"):
		spec := strings.TrimPrefix(header, "bytes=")
		parts := strings.SplitN(spec, "-", 2)
		fmt.Sscanf(parts[0], "%d", &start)
		if parts[1] != "" {
			fmt.Sscanf(parts[1], "%d", &end)
		} else {
			end = len(data) - 1
		}
	default:
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if start >= len(data) {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if end >= len(data) {
		end = len(data) - 1
	}
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
	w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
	w.WriteHeader(http.StatusPartialContent)
	w.Write(data[start : end+1])
}

// TestParallelDownloadReassemblesTheArchive checks that a file fetched with
// several range requests ends up byte-identical to the original.
func TestParallelDownloadReassemblesTheArchive(t *testing.T) {
	data := payload(3 * 1024 * 1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveRangeBytes(data, w, r)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Log:      func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}, Size: int64(len(data)), Connections: 4}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("the reassembled archive differs: got %d bytes, want %d", len(got), len(data))
	}
}

// TestParallelDownloadReportsGrowingProgress checks that the progress ticks
// grow with the part as a whole. Reporting the offset of the range that
// happens to finish first would make the progress jump to the end.
func TestParallelDownloadReportsGrowingProgress(t *testing.T) {
	data := payload(3 * 1024 * 1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveRangeBytes(data, w, r)
	}))
	defer server.Close()

	var (
		mu       sync.Mutex
		received []int64
	)
	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Progress: func(p Progress) {
				mu.Lock()
				received = append(received, p.Received)
				mu.Unlock()
			},
			Log: func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}, Size: int64(len(data)), Connections: 4}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(received) < 2 {
		t.Fatalf("expected several progress ticks, got %d", len(received))
	}
	if received[0] >= int64(len(data)) {
		t.Fatalf("the first tick already reported %d of %d bytes", received[0], len(data))
	}
	for i := 1; i < len(received); i++ {
		if received[i] < received[i-1] {
			t.Fatalf("the progress went backwards: %d after %d", received[i], received[i-1])
		}
	}
	if last := received[len(received)-1]; last > int64(len(data)) {
		t.Fatalf("the progress reported %d bytes, more than the %d of the file", last, len(data))
	}
}

// TestParallelDownloadFallsBackWhenRangesAreRefused checks that a server
// which ignores the Range header still ends up serving the file.
func TestParallelDownloadFallsBackWhenRangesAreRefused(t *testing.T) {
	data := payload(512 * 1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always answer with the whole file, ignoring the range.
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		w.Write(data)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Log:      func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}, Size: int64(len(data)), Connections: 4}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("the downloaded file differs: got %d bytes, want %d", len(got), len(data))
	}
}

// TestParallelDownloadUsesSeveralRequests checks that the archive really is
// fetched with more than one request — a single request would mean the
// ranges are not spread over several connections.
func TestParallelDownloadUsesSeveralRequests(t *testing.T) {
	// Big enough that the planner splits it into the four requested ranges.
	data := payload(5 * 1024 * 1024)
	var (
		mu       sync.Mutex
		requests int
		ranges   []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		ranges = append(ranges, r.Header.Get("Range"))
		mu.Unlock()
		serveRangeBytes(data, w, r)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Log:      func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}, Size: int64(len(data)), Connections: 4}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if requests < 4 {
		t.Fatalf("expected at least 4 range requests, got %d (%v)", requests, ranges)
	}
	closed := 0
	for _, header := range ranges {
		if strings.Contains(header, "-") && !strings.HasSuffix(header, "-") {
			closed++
		}
	}
	if closed < 4 {
		t.Fatalf("expected 4 closed ranges, got %d (%v)", closed, ranges)
	}
}

// TestParallelDownloadSpreadsOverTheMirrors checks that the ranges are not
// all fetched from the same mirror. Two mirrors of one host are usually two
// different machines, and a single machine caps one connection at a few
// hundred KB/s — giving every range its own mirror is what turns that cap
// into usable bandwidth.
func TestParallelDownloadSpreadsOverTheMirrors(t *testing.T) {
	data := payload(5 * 1024 * 1024)
	var (
		mu     sync.Mutex
		byHost = map[string]int{}
	)
	handler := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		byHost[r.Host]++
		mu.Unlock()
		serveRangeBytes(data, w, r)
	}
	first := httptest.NewServer(http.HandlerFunc(handler))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(handler))
	defer second.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   serverClientFor(first, second),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Log:      func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{
		ID:   "runtime",
		URLs: []string{first.URL + "/runtime.zip", second.URL + "/runtime.zip"},
		Size: int64(len(data)), Connections: 4,
	}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(byHost) < 2 {
		t.Fatalf("the ranges all came from one mirror: %v", byHost)
	}
	for host, count := range byHost {
		if count < 1 {
			t.Fatalf("mirror %s served %d requests", host, count)
		}
	}
	t.Logf("ranges per mirror: %v", byHost)
}

// serverClientFor returns a client that talks to both test servers.
func serverClientFor(servers ...*httptest.Server) *http.Client {
	return &http.Client{Timeout: 10 * time.Second}
}

// TestParallelDownloadFallsBackToAnotherMirror checks that a dead mirror
// does not cost the whole part: the ranges that failed there are fetched
// from the next mirror.
func TestParallelDownloadFallsBackToAnotherMirror(t *testing.T) {
	data := payload(5 * 1024 * 1024)
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveRangeBytes(data, w, r)
	}))
	defer live.Close()
	// A mirror that answers with an error for every range request.
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer dead.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   &http.Client{Timeout: 30 * time.Second},
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Log:      func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{
		ID:   "runtime",
		URLs: []string{dead.URL + "/runtime.zip", live.URL + "/runtime.zip"},
		Size: int64(len(data)), Connections: 4,
	}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("the reassembled archive differs: got %d bytes, want %d", len(got), len(data))
	}
}

// TestPlanChunksCoversTheWholeFile checks the range arithmetic.
func TestPlanChunksCoversTheWholeFile(t *testing.T) {
	for _, size := range []int64{1, 1024, 1 << 20, 5_000_000, 100_000_000} {
		for _, connections := range []int{1, 2, 4, 8} {
			chunks := planChunks(size, connections)
			if len(chunks) == 0 {
				t.Fatalf("no chunks planned for size=%d connections=%d", size, connections)
			}
			var covered int64
			for i, c := range chunks {
				if c.start != covered {
					t.Fatalf("size=%d connections=%d: chunk %d starts at %d, expected %d", size, connections, i, c.start, covered)
				}
				if c.end < c.start {
					t.Fatalf("size=%d connections=%d: chunk %d ends before it starts", size, connections, i)
				}
				covered = c.end + 1
			}
			if covered != size {
				t.Fatalf("size=%d connections=%d: the chunks cover %d bytes", size, connections, covered)
			}
		}
	}
}

// TestPlanChunksKeepsSmallFilesOnOneConnection checks that a small file is
// not split — the request overhead would cost more than the gain.
func TestPlanChunksKeepsSmallFilesOnOneConnection(t *testing.T) {
	chunks := planChunks(1024, 8)
	if len(chunks) != 1 {
		t.Fatalf("expected a single chunk, got %d", len(chunks))
	}
}
