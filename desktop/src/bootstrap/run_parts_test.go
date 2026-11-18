package bootstrap

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// partServer serves archives by path and counts how often each one is fetched.
type partServer struct {
	*httptest.Server
	mu    sync.Mutex
	count map[string]int
}

func newPartServer(t *testing.T, archives map[string][]byte) *partServer {
	t.Helper()
	server := &partServer{count: map[string]int{}}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := archives[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		server.mu.Lock()
		server.count[r.URL.Path]++
		server.mu.Unlock()
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		w.Write(data)
	}))
	t.Cleanup(server.Close)
	return server
}

func (s *partServer) fetches(path string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.count[path]
}

// optionalManifest is the shape PR-1 produces: one required root part plus an
// optional part that unpacks into its own subtree.
func optionalManifest(server *partServer, core, browser []byte) Manifest {
	return Manifest{
		Version:  "2.0.0",
		Platform: "win-x64",
		Parts: []Part{
			{
				ID:       "core",
				URLs:     []string{server.URL + "/core.zip"},
				Size:     int64(len(core)),
				SHA256:   checksum(core),
				Format:   "zip",
				Required: true,
			},
			{
				ID:       "browser",
				URLs:     []string{server.URL + "/browser.zip"},
				Size:     int64(len(browser)),
				SHA256:   checksum(browser),
				Format:   "zip",
				Target:   "packages/_parts/browser",
				Required: false,
			},
		},
	}
}

func TestRunPartsInstallsOnlyTheNamedOptionalPartAndKeepsTheRoot(t *testing.T) {
	core := testZipBytes(t, map[string]string{"core.txt": "core"})
	browser := testZipBytes(t, map[string]string{"browser.txt": "browser"})
	server := newPartServer(t, map[string][]byte{"/core.zip": core, "/browser.zip": browser})

	root := filepath.Join(t.TempDir(), "portable")
	opts := testOptions(t, root, optionalManifest(server, core, browser))
	opts.Merge = true

	if err := Run(opts); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "core.txt")); err != nil {
		t.Fatalf("required part was not unpacked: %v", err)
	}
	browserDir := filepath.Join(root, "packages", "_parts", "browser")
	if _, err := os.Stat(browserDir); !os.IsNotExist(err) {
		t.Fatalf("Run must skip the optional part, stat err=%v", err)
	}

	if err := RunParts(opts, []string{"browser"}); err != nil {
		t.Fatalf("RunParts: %v", err)
	}
	if _, err := os.Stat(filepath.Join(browserDir, "browser.txt")); err != nil {
		t.Fatalf("optional part was not unpacked: %v", err)
	}
	// The optional part lives in its own subtree; unpacking it must not wipe
	// the root part that was just installed.
	if _, err := os.Stat(filepath.Join(root, "core.txt")); err != nil {
		t.Fatalf("the on-demand part removed the root part: %v", err)
	}
	if got := server.fetches("/core.zip"); got != 1 {
		t.Fatalf("core archive was fetched %d times, want 1", got)
	}
	if got := server.fetches("/browser.zip"); got != 1 {
		t.Fatalf("browser archive was fetched %d times, want 1", got)
	}

	// A second request reuses the cached archive instead of downloading it again.
	if err := RunParts(opts, []string{"browser"}); err != nil {
		t.Fatalf("second RunParts: %v", err)
	}
	if got := server.fetches("/browser.zip"); got != 1 {
		t.Fatalf("browser archive was fetched %d times after reuse, want 1", got)
	}
}

func TestRunPartsRejectsAnUnknownPart(t *testing.T) {
	core := testZipBytes(t, map[string]string{"core.txt": "core"})
	server := newPartServer(t, map[string][]byte{"/core.zip": core})
	opts := testOptions(t, filepath.Join(t.TempDir(), "portable"), optionalManifest(server, core, core))

	err := RunParts(opts, []string{"missing"})
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("expected an unknown-part error, got %v", err)
	}
}

func TestRunPartsRejectsNoPartIDs(t *testing.T) {
	err := RunParts(Options{}, nil)
	if err == nil {
		t.Fatal("expected an error for an empty part list")
	}
}

func TestRunPartsRejectsPartsThatShareATarget(t *testing.T) {
	manifest := Manifest{Parts: []Part{
		{ID: "one", URLs: []string{"http://127.0.0.1:1/one.zip"}, Target: "packages", Required: false},
		{ID: "two", URLs: []string{"http://127.0.0.1:1/two.zip"}, Target: "packages", Required: false},
	}}
	err := RunParts(Options{Manifest: manifest}, []string{"one", "two"})
	if err == nil || !strings.Contains(err.Error(), "same target") {
		t.Fatalf("expected a shared-target error, got %v", err)
	}
}
