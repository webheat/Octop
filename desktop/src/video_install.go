package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"octop.desktop/bootstrap"
)

// This file implements the `environment_install` desktop action. It turns the
// self-service install card in the UI into a real download: the shell fetches
// a component manifest from the URL baked into defaultVideoComponentsURL,
// downloads each part with resume + SHA-256 verification (bootstrap.Run), and
// unpacks them into the same runtime directory the checker looks at. The
// native shell never runs an installer or touches system PATH.

// videoRuntimeInstallDir is where downloaded parts are unpacked. It is kept
// in lockstep with videoRuntimeDir(): an install must land in the first
// candidate the checker will pick, otherwise a stale copy in a higher-priority
// location would keep the freshly installed runtime invisible.
//
// Priority: an explicit env override, then <exe dir>/video-runtime (the
// portable layout the release packages ship), then the per-user cache used by
// the NSIS component installer for backwards compatibility.
func videoRuntimeInstallDir() (string, error) {
	if p := strings.TrimSpace(os.Getenv("OCTOP_DESKTOP_VIDEO_RUNTIME")); p != "" {
		return p, nil
	}
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "video-runtime")
		if st, statErr := os.Stat(candidate); statErr == nil && st.IsDir() {
			return candidate, nil
		}
		// No runtime beside the executable yet — that is the normal first-run
		// case. Create it there so the very next environment check finds it.
		return candidate, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "Octop", "video-runtime"), nil
}

// componentsManifestPlatform maps the current build to the manifest platform
// key emitted by scripts/pack_video_components.py. An empty string means the
// host platform has no published runtime.
func componentsManifestPlatform() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	if runtime.GOARCH == "arm64" {
		return "win-arm64"
	}
	return "win-x64"
}

func environmentProgress(value float64) *float64 { return &value }

// manifestURLs splits a comma-separated URL list and sanitizes each entry.
// Multiple independent node URLs let bootstrap.LoadManifest fail over when one
// node is down — DNS round-robin alone cannot detect or route around a failure.
// Invalid entries are dropped; the first valid URL stays primary. Order is kept.
func manifestURLs(raw string) []string {
	var result []string
	seen := make(map[string]bool)
	for _, part := range strings.Split(raw, ",") {
		clean := sanitizeEnvironmentInstallerURL(part)
		if clean == "" || seen[clean] {
			continue
		}
		seen[clean] = true
		result = append(result, clean)
	}
	return result
}

// firstNonEmpty returns the first trimmed, non-blank value. It is used for
// build-time defaults that an environment variable may override at runtime.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func (m *videoManager) startEnvironmentInstall(token string) (VideoEnvironmentStatus, error) {
	// Authentication is performed by environmentAction before dispatch.
	m.mu.Lock()
	if m.installRunning || m.environmentRunning || m.active != "" {
		m.mu.Unlock()
		return VideoEnvironmentStatus{}, videoErr("BUSY")
	}
	// A runtime override lets local builds and emergency source swaps avoid a
	// full repackage; the build-time value remains the default for releases.
	// Both may hold a comma-separated list of independent node URLs.
	urls := manifestURLs(firstNonEmpty(os.Getenv("OCTOP_DESKTOP_VIDEO_COMPONENTS_URL"), defaultVideoComponentsURL))
	if len(urls) == 0 {
		m.mu.Unlock()
		return VideoEnvironmentStatus{}, videoErr("NO_INSTALLER")
	}
	m.installRunning = true
	status := VideoEnvironmentStatus{
		State:     "installing",
		Stage:     environmentStage("components"),
		Progress:  environmentProgress(0),
		CheckedAt: time.Now().Unix(),
	}
	m.environment = status
	m.environmentLogKey = environmentLogKey(status)
	m.mu.Unlock()
	logVideoEnvironment(status)

	go m.runEnvironmentInstall(urls)
	return status, nil
}

func (m *videoManager) runEnvironmentInstall(manifestURLs []string) {
	defer func() {
		m.mu.Lock()
		m.installRunning = false
		m.mu.Unlock()
	}()

	// Probe the DNS records behind the component host once. Every connection
	// made by this client (manifest and parts alike) then prefers a reachable
	// node, so a dead server in a round-robin DNS set cannot stall the install.
	installClient := componentsDownloadClient(manifestURLs, log.Printf)
	manifest, err := bootstrap.LoadManifest(
		manifestURLs, installClient, "",
		func(format string, args ...any) { log.Printf("video install: "+format, args...) },
	)
	if err != nil {
		m.finishInstall("DOWNLOAD_FAILED")
		return
	}
	platform := componentsManifestPlatform()
	if platform == "" || (manifest.Platform != "" && manifest.Platform != platform) {
		m.finishInstall("PACKAGE_INVALID")
		return
	}
	root, err := videoRuntimeInstallDir()
	if err != nil {
		m.finishInstall("ENV_DISK_FULL")
		return
	}
	cacheDir := filepath.Join(m.environmentCache(), "install")

	// Weight progress by each part's declared size so a large core download
	// does not jump from 0% to 50% the instant the small browser part finishes.
	var total int64
	for _, part := range manifest.Parts {
		if part.Required || part.ID == "browser" {
			total += part.Size
		}
	}
	received := map[string]int64{}
	report := func(p bootstrap.Progress) {
		received[p.PartID] = p.Received
		var done int64
		for _, value := range received {
			done += value
		}
		stage := "components"
		if p.PartID == "browser" {
			stage = "browser"
		}
		fraction := 0.0
		if total > 0 {
			fraction = float64(done) / float64(total)
			if fraction > 1 {
				fraction = 1
			}
		}
		m.setInstallProgress(stage, fraction)
	}

	err = bootstrap.Run(bootstrap.Options{
		Root:     root,
		CacheDir: cacheDir,
		Manifest: manifest,
		Client:   installClient,
		Merge:    true,
		Progress: report,
		Log: func(format string, args ...any) {
			log.Printf("video install: "+format, args...)
		},
	})
	if err != nil {
		code := "DOWNLOAD_FAILED"
		if errors.Is(err, bootstrap.ErrChecksumMismatch) {
			code = "PACKAGE_INVALID"
		}
		m.finishInstall(code)
		return
	}

	// Parts are in place. Let the existing checker decide whether the runtime
	// is ready or still needs a one-off render verification.
	if _, err := m.startEnvironment("check"); err != nil {
		status := VideoEnvironmentStatus{
			State:     "needs_setup",
			Stage:     environmentStage("components"),
			CheckedAt: time.Now().Unix(),
		}
		m.mu.Lock()
		m.environment = status
		m.environmentLogKey = environmentLogKey(status)
		m.mu.Unlock()
		logVideoEnvironment(status)
	}
}

func (m *videoManager) setInstallProgress(stage string, progress float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.installRunning {
		return
	}
	m.environment = VideoEnvironmentStatus{
		State:     "installing",
		Stage:     environmentStage(stage),
		Progress:  environmentProgress(progress),
		CheckedAt: time.Now().Unix(),
	}
}

func (m *videoManager) finishInstall(code string) {
	m.mu.Lock()
	if m.installRunning {
		status := VideoEnvironmentStatus{
			State:           "failed",
			ErrorCode:       environmentErrorCode(code),
			CheckedAt:       time.Now().Unix(),
			RequiresInstall: true,
		}
		m.environment = status
		m.environmentLogKey = environmentLogKey(status)
	}
	status := m.environment
	m.mu.Unlock()
	logVideoEnvironment(status)
}
