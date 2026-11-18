package main

import (
	"os/exec"
	"strings"
	"testing"
)

// The thin shell loads the Dashboard from the server, so the page has to be
// told it is inside the desktop client — otherwise it registers the
// production Service Worker and the WebView2 profile serves a stale build.
func TestDesktopFrontendMarkerDeclaresShellAndPurgesWorker(t *testing.T) {
	script := desktopFrontendMarkerJS()

	for _, want := range []string{
		"window.octopDesktopShell=true",
		"navigator.serviceWorker.getRegistrations()",
		"r.unregister()",
		"caches.delete(k)",
		// The document on screen was rendered by the stale worker, so it only
		// becomes correct after a reload.
		"window.location.reload()",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("marker script must contain %q", want)
		}
	}

	// The purge must be guarded so it runs once per document.
	if !strings.Contains(script, "window.__octopDesktopSwCleaned") {
		t.Fatal("marker script must guard the purge against repeated runs")
	}
}

func TestDesktopFrontendMarkerIsValidJavaScript(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is unavailable")
	}
	cmd := exec.Command(node, "-e", "new (require('node:vm').Script)(process.argv[1])", desktopFrontendMarkerJS())
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("marker JavaScript syntax: %v: %s", err, output)
	}
}
