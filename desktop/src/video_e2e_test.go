package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestVideoInstallEndToEndFromLocalComponents drives the real production
// path — manifest fetch, part download with SHA-256 verification, unpack into
// the runtime directory, environment check and the render verification —
// against a locally served component bundle.
//
// It is the regression guard for the bug that made a freshly installed client
// report "components missing" forever: the worker used to answer a plain
// needs_setup without an error code, and the UI could not tell "install
// again" apart from "verify once".
//
// The test is skipped unless OCTOP_VIDEO_E2E_COMPONENTS points at a served
// component directory, because it needs a ~225 MB bundle.
func TestVideoInstallEndToEndFromLocalComponents(t *testing.T) {
	root := t.TempDir()
	componentsRoot := os.Getenv("OCTOP_VIDEO_E2E_COMPONENTS")
	if componentsRoot == "" {
		t.Skip("set OCTOP_VIDEO_E2E_COMPONENTS to a served component directory")
	}
	// The client expects <base>/<version>/<target>/<file>.
	server := httptest.NewServer(http.FileServer(http.Dir(componentsRoot)))
	defer server.Close()

	t.Setenv("OCTOP_HOME", root)
	// A dedicated install target keeps the developer's own runtime intact.
	installDir := filepath.Join(root, "video-runtime")
	t.Setenv("OCTOP_DESKTOP_VIDEO_RUNTIME", installDir)
	manifestURL := server.URL + "/video-components/1.4.0/win-x64/manifest.json"
	t.Setenv("OCTOP_DESKTOP_VIDEO_COMPONENTS_URL", manifestURL)

	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"id":42}`)
	}))
	defer auth.Close()

	m := newVideoManager(auth.URL)
	status, err := m.environmentAction("secret", "environment_install")
	if err != nil {
		t.Fatalf("start the install: %v", err)
	}
	if status.State != "installing" {
		t.Fatalf("install did not start: %+v", status)
	}

	// The install downloads ~225 MB; give it room.
	deadline := time.Now().Add(20 * time.Minute)
	for time.Now().Before(deadline) {
		status, err = m.environmentAction("secret", "environment_status")
		if err != nil {
			t.Fatal(err)
		}
		if status.State == "needs_setup" || status.State == "failed" || status.State == "ready" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if status.State == "failed" {
		t.Fatalf("the install failed: %+v", status)
	}
	if status.State == "installing" {
		t.Fatal("the install did not finish within the deadline")
	}

	// The parts must be on disk and usable.
	for _, name := range []string{"runtime.json", "desktop-worker.mjs", "render.mjs"} {
		if _, err := os.Stat(filepath.Join(installDir, name)); err != nil {
			t.Fatalf("the runtime is missing %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(installDir, "node.exe")); err != nil {
		t.Fatalf("the runtime has no node: %v", err)
	}

	// The whole point: an installed runtime must never ask to be installed
	// again. It may ask for a verification, but with requiresInstall=false.
	if status.RequiresInstall {
		t.Fatalf("an installed runtime must not require an install: %+v", status)
	}
	if status.ErrorCode == "RUNTIME_MISSING" || status.ErrorCode == "BROWSER_MISSING" {
		t.Fatalf("an installed runtime reported a missing component: %+v", status)
	}
	if status.ErrorCode != "ENV_NOT_VERIFIED" {
		t.Fatalf("expected ENV_NOT_VERIFIED, got %+v", status)
	}

	// The verification must turn the environment ready.
	if _, err := m.environmentAction("secret", "environment_verify"); err != nil {
		t.Fatalf("start the verification: %v", err)
	}
	deadline = time.Now().Add(20 * time.Minute)
	for time.Now().Before(deadline) {
		status, err = m.environmentAction("secret", "environment_status")
		if err != nil {
			t.Fatal(err)
		}
		if status.State == "ready" || status.State == "failed" {
			break
		}
		time.Sleep(time.Second)
	}
	if status.State != "ready" {
		t.Fatalf("the verification did not reach the ready state: %+v", status)
	}

	// A ready environment must survive a re-check.
	if _, err := m.environmentAction("secret", "environment_check"); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		status, err = m.environmentAction("secret", "environment_status")
		if err != nil {
			t.Fatal(err)
		}
		if status.State == "ready" || status.State == "failed" || status.State == "needs_setup" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if status.State != "ready" {
		t.Fatalf("a verified environment did not stay ready: %+v", status)
	}
}

// TestVideoRuntimeLayoutMatchesBrowserLookup guards the layout the renderer
// looks the headless shell up by. Remotion installs it as
// <runtime>/node_modules/.remotion/chrome-headless-shell/win64/<dir>/, and a
// mismatch silently falls back to the host's Chrome — or to no browser at all.
func TestVideoRuntimeLayoutMatchesBrowserLookup(t *testing.T) {
	runtimeDir := os.Getenv("OCTOP_DESKTOP_VIDEO_RUNTIME")
	if runtimeDir == "" {
		runtimeDir = filepath.Join("video-runtime")
	}
	exe := filepath.Join(runtimeDir, "node_modules", ".remotion", "chrome-headless-shell", "win64", "chrome-headless-shell-win64", "chrome-headless-shell.exe")
	if _, err := os.Stat(exe); err != nil {
		t.Skipf("no staged headless shell at %s: %v", exe, err)
	}
	// The lookup path in render.mjs must match the file that is really there.
	render, err := os.ReadFile(filepath.Join(runtimeDir, "render.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(render), `chrome-headless-shell", "win64", "chrome-headless-shell-win64"`) {
		t.Fatal("render.mjs does not look the headless shell up in the installed layout")
	}
}
