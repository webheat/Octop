package main

import (
	"crypto/sha256"
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

	"octop.desktop/bootstrap"
)

// slimInstall builds the state a slim installer starts in: no embedded
// payload, no package beside the executable, and a runtime URL to fetch.
func slimInstall(t *testing.T, version string) *httptest.Server {
	t.Helper()
	home := t.TempDir()
	t.Setenv("OCTOP_HOME", home)
	t.Setenv("OCTOP_DESKTOP_PORTABLE_ZIP", "")

	zipPath := filepath.Join(t.TempDir(), "remote.zip")
	writeTestGreenZip(t, zipPath, version)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, zipPath)
	}))
	t.Cleanup(server.Close)

	prevURL, prevVersion := portableRuntimeURL, portableRuntimeVersion
	portableRuntimeURL = server.URL + "/Octop-portable.zip"
	portableRuntimeVersion = version
	t.Cleanup(func() { portableRuntimeURL, portableRuntimeVersion = prevURL, prevVersion })

	prevEmbedded := embeddedPortable
	embeddedPortable = nil
	t.Cleanup(func() { embeddedPortable = prevEmbedded })

	return server
}

func TestEnsurePortableDownloadsRuntimeWhenNoneIsBundled(t *testing.T) {
	slimInstall(t, "1.2.0")

	var statuses []string
	if err := ensurePortable(LocaleZH, func(status string) {
		statuses = append(statuses, status)
	}); err != nil {
		t.Fatal(err)
	}
	if !launchReady(portableDir()) {
		t.Fatal("downloaded runtime was not extracted into the portable directory")
	}
	if got := portableVersion(portableDir()); got != "1.2.0" {
		t.Fatalf("portable version = %q, want 1.2.0", got)
	}
	if !containsStatus(statuses, "正在下载运行环境") {
		t.Fatalf("no download progress was reported: %v", statuses)
	}
	// The downloaded archive is a cache, not a permanent copy.
	if _, err := os.Stat(filepath.Join(octopHome(), "portable-runtime.zip")); err == nil {
		t.Fatal("downloaded archive was not cleaned up")
	}
}

func TestEnsurePortableKeepsRuntimeWhenItMatchesTheDownload(t *testing.T) {
	slimInstall(t, "1.2.0")
	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatal(err)
	}
	before := portableVersion(portableDir())

	var statuses []string
	if err := ensurePortable(LocaleZH, func(status string) {
		statuses = append(statuses, status)
	}); err != nil {
		t.Fatal(err)
	}
	if got := portableVersion(portableDir()); got != before {
		t.Fatalf("portable version changed from %q to %q", before, got)
	}
	if containsStatus(statuses, "正在下载运行环境") {
		t.Fatalf("runtime was downloaded again although it matches: %v", statuses)
	}
}

func TestEnsurePortableRefreshesRuntimeWhenTheDownloadIsNewer(t *testing.T) {
	slimInstall(t, "1.2.0")
	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatal(err)
	}

	// A newer installer ships a newer runtime URL.
	prevVersion := portableRuntimeVersion
	portableRuntimeVersion = "1.3.0"
	t.Cleanup(func() { portableRuntimeVersion = prevVersion })

	var statuses []string
	if err := ensurePortable(LocaleZH, func(status string) {
		statuses = append(statuses, status)
	}); err != nil {
		t.Fatal(err)
	}
	if !containsStatus(statuses, "正在下载运行环境") {
		t.Fatalf("newer runtime was not downloaded: %v", statuses)
	}
}

func TestEnsurePortableFailsWhenTheRuntimeDownloadFails(t *testing.T) {
	slimInstall(t, "1.2.0")
	portableRuntimeURL = "http://127.0.0.1:1/Octop-portable.zip"

	err := ensurePortable(LocaleZH, func(string) {})
	if err == nil {
		t.Fatal("expected an error when the runtime download fails")
	}
	if !strings.Contains(err.Error(), "运行环境下载失败") {
		t.Fatalf("error is not localized: %v", err)
	}
}

func TestEnsurePortableFallsBackToTheNextMirror(t *testing.T) {
	slimInstall(t, "1.2.0")

	// The first mirror is unreachable; the second one serves the runtime.
	zipPath := filepath.Join(t.TempDir(), "mirror.zip")
	writeTestGreenZip(t, zipPath, "1.2.0")
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, zipPath)
	}))
	defer mirror.Close()

	portableRuntimeURL = "http://127.0.0.1:1/missing.zip," + mirror.URL + "/Octop-portable.zip"

	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if !launchReady(portableDir()) {
		t.Fatal("the fallback mirror was not used")
	}
}

func containsStatus(statuses []string, want string) bool {
	for _, status := range statuses {
		if strings.Contains(status, want) {
			return true
		}
	}
	return false
}

// TestEnsurePortableResumesAnInterruptedDownload proves that a download that
// dies halfway is continued instead of started over.
func TestEnsurePortableResumesAnInterruptedDownload(t *testing.T) {
	slimInstall(t, "1.2.0")

	// Serve the runtime, but drop the connection after half of it.
	zipPath := filepath.Join(t.TempDir(), "remote.zip")
	writeTestGreenZip(t, zipPath, "1.2.0")
	data, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	requests := 0
	ranges := []string{}
	drop := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		ranges = append(ranges, r.Header.Get("Range"))
		dropping := drop
		mu.Unlock()
		if dropping {
			// Drop the connection after half of the body.
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
		serveTestRange(data, w, r)
	}))
	defer server.Close()
	portableRuntimeURL = server.URL + "/Octop-portable.zip"

	// Do not wait between the attempts of the downloader.
	prevBackoff := bootstrap.DefaultBackoff
	bootstrap.DefaultBackoff = []time.Duration{0, 0}
	t.Cleanup(func() { bootstrap.DefaultBackoff = prevBackoff })

	if err := ensurePortable(LocaleZH, func(string) {}); err == nil {
		t.Fatal("expected the interrupted download to fail")
	}

	// The server works again — the next launch continues the download.
	mu.Lock()
	drop = false
	mu.Unlock()

	// The half-downloaded archive stays on disk.
	cached := filepath.Join(octopHome(), "portable-cache", "parts", "runtime.zip")
	info, err := os.Stat(cached)
	if err != nil {
		t.Fatalf("the partial download was not kept: %v", err)
	}
	if info.Size() == 0 || info.Size() >= int64(len(data)) {
		t.Fatalf("the cached archive has %d bytes, want a partial file", info.Size())
	}

	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatalf("the second attempt failed: %v", err)
	}
	if !launchReady(portableDir()) {
		t.Fatal("the runtime was not installed")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(ranges) < 2 || ranges[1] == "" {
		t.Fatalf("the second request did not continue the download: %v", ranges)
	}
}

// TestEnsurePortableInstallsFromTheManifest proves that a slim installer with
// a manifest fetches the runtime it describes and checks its checksum.
func TestEnsurePortableInstallsFromTheManifest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OCTOP_HOME", home)
	t.Setenv("OCTOP_DESKTOP_PORTABLE_ZIP", "")

	zipPath := filepath.Join(t.TempDir(), "remote.zip")
	writeTestGreenZip(t, zipPath, "1.2.0")
	data, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "manifest.json") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{
  "version": "1.2.0",
  "parts": [
    {
      "id": "runtime",
      "urls": ["%s/Octop-portable.zip"],
      "sha256": "%x",
      "format": "zip",
      "stripRoot": true,
      "required": true
    }
  ]
}`, server.URL, sum)
			return
		}
		serveTestRange(data, w, r)
	}))
	defer server.Close()

	prevURL, prevVersion := portableRuntimeURL, portableRuntimeVersion
	portableRuntimeURL = ""
	portableRuntimeVersion = ""
	t.Cleanup(func() { portableRuntimeURL, portableRuntimeVersion = prevURL, prevVersion })

	prevManifest := portableRuntimeManifestURL
	portableRuntimeManifestURL = server.URL + "/manifest.json"
	t.Cleanup(func() { portableRuntimeManifestURL = prevManifest })

	prevEmbedded := embeddedPortable
	embeddedPortable = nil
	t.Cleanup(func() { embeddedPortable = prevEmbedded })

	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatalf("the manifest install failed: %v", err)
	}
	if !launchReady(portableDir()) {
		t.Fatal("the runtime was not installed")
	}
	if got := portableVersion(portableDir()); got != "1.2.0" {
		t.Fatalf("portable version = %q, want 1.2.0", got)
	}
}

// TestEnsurePortableKeepsTheRuntimeWhenTheManifestIsUnreachable proves that a
// client with an installed runtime still starts without a network.
func TestEnsurePortableKeepsTheRuntimeWhenTheManifestIsUnreachable(t *testing.T) {
	slimInstall(t, "1.2.0")
	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatal(err)
	}

	prevManifest := portableRuntimeManifestURL
	portableRuntimeManifestURL = "http://127.0.0.1:1/manifest.json"
	t.Cleanup(func() { portableRuntimeManifestURL = prevManifest })

	if err := ensurePortable(LocaleZH, func(string) {}); err != nil {
		t.Fatalf("the installed runtime was not kept: %v", err)
	}
	if !launchReady(portableDir()) {
		t.Fatal("the runtime is gone")
	}
}

// TestBootstrapRuntimeRejectsAManifestForAnotherPlatform makes sure a manifest
// written for a different OS/arch never gets unpacked over this install.
func TestBootstrapRuntimeRejectsAManifestForAnotherPlatform(t *testing.T) {
	t.Setenv("OCTOP_HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), "portable")
	manifest := &bootstrap.Manifest{
		Version:  "1.2.0",
		Platform: "plan9-z80",
		Parts: []bootstrap.Part{{
			ID:       "runtime",
			URLs:     []string{"http://127.0.0.1:1/Octop-portable.zip"},
			Format:   "zip",
			Required: true,
		}},
	}
	err := bootstrapRuntime(root, LocaleEN, func(string) {}, manifest)
	if err == nil || !strings.Contains(err.Error(), "platform mismatch") {
		t.Fatalf("expected a platform mismatch, got %v", err)
	}
}

// serveTestRange answers range requests the way a release server does.
func serveTestRange(data []byte, w http.ResponseWriter, r *http.Request) {
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
