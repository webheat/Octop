package bootstrap

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
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

// testOptions builds options that never wait between two attempts.
func testOptions(t *testing.T, root string, manifest Manifest) Options {
	t.Helper()
	return Options{
		Root:     root,
		CacheDir: filepath.Join(t.TempDir(), "cache"),
		Manifest: manifest,
		Client:   &http.Client{Timeout: 10 * time.Second},
		Attempts: 2,
		Backoff:  []time.Duration{0},
		Log:      func(format string, args ...any) { t.Logf(format, args...) },
	}
}

// payload is the file the fake mirrors serve.
func payload(size int) []byte {
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i % 251)
	}
	return data
}

func checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// serveRange answers range requests the way a release server does.
func serveRange(data []byte, w http.ResponseWriter, r *http.Request) {
	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		w.Write(data)
		return
	}
	var start int
	if _, err := fmt.Sscanf(rangeHeader, "bytes=%d-", &start); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if start >= len(data) {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(data)-1, len(data)))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)-start))
	w.WriteHeader(http.StatusPartialContent)
	w.Write(data[start:])
}

func TestFetchResumesAfterTheConnectionDrops(t *testing.T) {
	data := payload(256 * 1024)
	var mu sync.Mutex
	var ranges []string
	requests := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		attempt := requests
		ranges = append(ranges, r.Header.Get("Range"))
		mu.Unlock()

		if attempt == 1 {
			// Drop the connection halfway through the body.
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("the test server cannot hijack the connection")
				return
			}
			conn, buf, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack failed: %v", err)
				return
			}
			fmt.Fprintf(buf, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", len(data))
			buf.Write(data[:len(data)/2])
			buf.Flush()
			conn.Close()
			return
		}
		serveRange(data, w, r)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 3,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
			Log:      func(format string, args ...any) { t.Logf(format, args...) },
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("the resumed file has %d bytes, want %d", len(got), len(data))
	}
	mu.Lock()
	defer mu.Unlock()
	if len(ranges) < 2 {
		t.Fatalf("expected a second request, got %d", len(ranges))
	}
	if ranges[1] == "" {
		t.Fatal("the second request did not ask for a range")
	}
}

func TestFetchRestartsWhenTheServerIgnoresTheRange(t *testing.T) {
	data := payload(64 * 1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// No range support at all: the whole file comes back every time.
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		w.Write(data)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	if err := os.WriteFile(dest, []byte("half a file"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("the file has %d bytes, want %d", len(got), len(data))
	}
}

func TestFetchSwitchesToTheNextMirrorOnAChecksumMismatch(t *testing.T) {
	data := payload(32 * 1024)
	wrong := payload(32 * 1024)
	for i := range wrong {
		wrong[i] = byte(255 - i%251)
	}

	var mu sync.Mutex
	badRequests := 0
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		badRequests++
		mu.Unlock()
		w.Header().Set("Content-Length", strconv.Itoa(len(wrong)))
		w.WriteHeader(http.StatusOK)
		w.Write(wrong)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveRange(data, w, r)
	}))
	defer good.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   good.Client(),
			Attempts: 3,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{bad.URL + "/runtime.zip", good.URL + "/runtime.zip"}}
	if err := f.fetch(part, dest, checksum(data)); err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("the fallback mirror did not serve the runtime")
	}
	mu.Lock()
	defer mu.Unlock()
	if badRequests != 1 {
		t.Fatalf("the broken mirror was asked %d times, want 1", badRequests)
	}
}

func TestFetchFailsWhenEveryMirrorServesTheWrongBytes(t *testing.T) {
	data := payload(16 * 1024)
	wrong := payload(16 * 1024)
	wrong[0] = 0xff
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(wrong)))
		w.WriteHeader(http.StatusOK)
		w.Write(wrong)
	}))
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "runtime.zip")
	f := &fetcher{
		opts: Options{
			Client:   server.Client(),
			Attempts: 2,
			Backoff:  []time.Duration{0},
			MaxBytes: DefaultMaxBytes,
		},
		log: func(format string, args ...any) { t.Logf(format, args...) },
	}
	part := Part{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}}
	err := f.fetch(part, dest, checksum(data))
	if err == nil {
		t.Fatal("expected a checksum error")
	}
	if !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, statErr := os.Stat(dest); statErr == nil {
		t.Fatal("the tampered archive was left on disk")
	}
}

func TestRunInstallsTheRuntimeAndRemembersIt(t *testing.T) {
	data := testZipBytes(t, map[string]string{
		"Octop-test/launch.py":          "print('hello')",
		"Octop-test/runtime/python.exe": string(payload(32 * 1024)),
	})

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		serveRange(data, w, r)
	}))
	defer server.Close()

	root := filepath.Join(t.TempDir(), "portable")
	opts := testOptions(t, root, Manifest{
		Version: "1.2.0",
		Parts: []Part{{
			ID:        "runtime",
			URLs:      []string{server.URL + "/runtime.zip"},
			SHA256:    checksum(data),
			Format:    "zip",
			StripRoot: true,
			Required:  true,
		}},
	})
	opts.Client = server.Client()
	if err := Run(opts); err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "launch.py")); err != nil {
		t.Fatalf("the runtime was not unpacked: %v", err)
	}
	statePath := filepath.Join(opts.CacheDir, "state.json")
	state, err := loadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if state.Version != "1.2.0" {
		t.Fatalf("state version = %q", state.Version)
	}
	if _, ok := state.Parts["runtime"]; !ok {
		t.Fatal("the state file does not list the runtime part")
	}

	// A second run must reuse the cached archive instead of downloading again.
	if err := Run(opts); err != nil {
		t.Fatalf("second run failed: %v", err)
	}
	if requests != 1 {
		t.Fatalf("the runtime was downloaded %d times, want 1", requests)
	}
}

func TestRunSkipsOptionalParts(t *testing.T) {
	root := filepath.Join(t.TempDir(), "portable")
	opts := testOptions(t, root, Manifest{
		Version: "1.2.0",
		Parts: []Part{
			{ID: "runtime", URLs: []string{"http://127.0.0.1:1/runtime.zip"}, Required: true},
			{ID: "browser", URLs: []string{"http://127.0.0.1:1/browser.zip"}},
		},
	})
	err := Run(opts)
	if err == nil {
		t.Fatal("expected the required part to fail")
	}
	if !strings.Contains(err.Error(), "runtime") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExtractTarGz(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "part.tar.gz")
	writeTestTarGz(t, archive, map[string]string{
		"part/launch.py":       "print('hello')",
		"part/runtime/py.exe":  "binary",
		"part/nested/data.txt": "payload",
	})

	dest := filepath.Join(t.TempDir(), "out")
	if err := Extract(archive, dest, "tar.gz", true); err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dest, "runtime", "py.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "binary" {
		t.Fatalf("unexpected content %q", data)
	}
	if _, err := os.Stat(filepath.Join(dest, "launch.py")); err != nil {
		t.Fatalf("the launch script is missing: %v", err)
	}
}

func TestExtractRejectsPathsOutsideTheDestination(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "evil.zip")
	writeTestZipEntries(t, archive, map[string]string{"../escaped.txt": "nope"})

	dest := filepath.Join(t.TempDir(), "out")
	err := Extract(archive, dest, "zip", false)
	if err == nil {
		t.Fatal("expected the escaping path to be rejected")
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(dest), "escaped.txt")); statErr == nil {
		t.Fatal("the file escaped the destination directory")
	}
}

// testZipBytes builds a zip in memory whose entries all sit under one top
// directory.
func testZipBytes(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := newZipWriter(t, &buffer)
	for name, content := range entries {
		if err := writer.Add(name, []byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// writeTestZipEntries writes a zip with the given entries.
func writeTestZipEntries(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	writer := newZipWriter(t, file)
	for name, content := range entries {
		if err := writer.Add(name, []byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
}

// zipWriter is a small helper around archive/zip for the tests.
type zipWriter struct {
	writer *zip.Writer
}

func newZipWriter(t *testing.T, file io.Writer) *zipWriter {
	t.Helper()
	return &zipWriter{writer: zip.NewWriter(file)}
}

func (z *zipWriter) Add(name string, content []byte) error {
	entry, err := z.writer.Create(name)
	if err != nil {
		return err
	}
	_, err = entry.Write(content)
	return err
}

func (z *zipWriter) Close() error {
	return z.writer.Close()
}

// writeTestTarGz writes a gzipped tar with the given entries.
func writeTestTarGz(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	for name, content := range entries {
		header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePartsMergeMode(t *testing.T) {
	core := Part{ID: "core", URLs: []string{"https://x/core.zip"}, Target: ""}
	browser := Part{ID: "browser", URLs: []string{"https://x/browser.zip"}, Target: "node_modules/.remotion/chrome-headless-shell"}

	if err := validateParts([]Part{core, browser}, false); err == nil {
		t.Fatal("non-merge mode must reject a root part combined with another part")
	}
	if err := validateParts([]Part{core, browser}, true); err != nil {
		t.Fatalf("merge mode must accept core+browser: %v", err)
	}
	if err := validateParts([]Part{browser, core}, true); err == nil {
		t.Fatal("merge mode must reject a root part that is not first")
	}
}

func TestRunMergeLayersPartsIntoOneRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "video-runtime")

	coreZip := filepath.Join(t.TempDir(), "core.zip")
	writeTestZipEntries(t, coreZip, map[string]string{"node.exe": "NODE", "desktop-worker.mjs": "WORKER", "runtime.json": "{}"})
	browserZip := filepath.Join(t.TempDir(), "browser.zip")
	writeTestZipEntries(t, browserZip, map[string]string{"win64/chrome.exe": "CHROME"})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/core.zip":
			serveRange(mustRead(t, coreZip), w, r)
		case "/browser.zip":
			serveRange(mustRead(t, browserZip), w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	coreData := mustRead(t, coreZip)
	browserData := mustRead(t, browserZip)
	manifest := Manifest{
		Version: "1.4.0-test",
		Parts: []Part{
			{ID: "core", URLs: []string{server.URL + "/core.zip"}, Size: int64(len(coreData)), SHA256: checksum(coreData), Format: "zip", Required: true},
			{ID: "browser", URLs: []string{server.URL + "/browser.zip"}, Size: int64(len(browserData)), SHA256: checksum(browserData), Format: "zip", Target: "node_modules/.remotion/chrome-headless-shell", Required: true},
		},
	}
	opts := testOptions(t, root, manifest)
	opts.Merge = true
	if err := Run(opts); err != nil {
		t.Fatalf("merge run failed: %v", err)
	}

	for name, want := range map[string]string{
		"node.exe":     "NODE",
		"runtime.json": "{}",
		"node_modules/.remotion/chrome-headless-shell/win64/chrome.exe": "CHROME",
	} {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
		if string(got) != want {
			t.Fatalf("%s: got %q, want %q", name, got, want)
		}
	}
}

// TestRunMergeAppendsToSharedTarget layers a root part, a wiping part and an
// append part into the same tree — the shape of the sharded portable runtime
// (runtime + launchers, then deps-core, then app, all under packages/).
func TestRunMergeAppendsToSharedTarget(t *testing.T) {
	root := filepath.Join(t.TempDir(), "portable")

	rootZip := filepath.Join(t.TempDir(), "runtime.zip")
	writeTestZipEntries(t, rootZip, map[string]string{
		"runtime/python.exe": "PYTHON",
		"launch.py":          "LAUNCH",
	})
	depsZip := filepath.Join(t.TempDir(), "deps-core.zip")
	writeTestZipEntries(t, depsZip, map[string]string{
		"requests/__init__.py": "REQUESTS",
	})
	appZip := filepath.Join(t.TempDir(), "app.zip")
	writeTestZipEntries(t, appZip, map[string]string{
		"octop/__init__.py":            "OCTOP",
		"octop-1.0.dist-info/METADATA": "Version: 1.0",
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/runtime.zip":
			serveRange(mustRead(t, rootZip), w, r)
		case "/deps-core.zip":
			serveRange(mustRead(t, depsZip), w, r)
		case "/app.zip":
			serveRange(mustRead(t, appZip), w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	rootData := mustRead(t, rootZip)
	depsData := mustRead(t, depsZip)
	appData := mustRead(t, appZip)
	manifest := Manifest{
		Version: "1.4.0-test",
		Parts: []Part{
			{ID: "runtime", URLs: []string{server.URL + "/runtime.zip"}, Size: int64(len(rootData)), SHA256: checksum(rootData), Format: "zip", Required: true},
			{ID: "deps-core", URLs: []string{server.URL + "/deps-core.zip"}, Size: int64(len(depsData)), SHA256: checksum(depsData), Format: "zip", Target: "packages", Required: true},
			{ID: "app", URLs: []string{server.URL + "/app.zip"}, Size: int64(len(appData)), SHA256: checksum(appData), Format: "zip", Target: "packages", Append: true, Required: true},
		},
	}
	opts := testOptions(t, root, manifest)
	opts.Merge = true
	if err := Run(opts); err != nil {
		t.Fatalf("sharded run failed: %v", err)
	}

	for name, want := range map[string]string{
		"runtime/python.exe":                    "PYTHON",
		"launch.py":                             "LAUNCH",
		"packages/requests/__init__.py":         "REQUESTS",
		"packages/octop/__init__.py":            "OCTOP",
		"packages/octop-1.0.dist-info/METADATA": "Version: 1.0",
	} {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
		if string(got) != want {
			t.Fatalf("%s: got %q, want %q", name, got, want)
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
