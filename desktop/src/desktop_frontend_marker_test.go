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
		// The profile marker makes later navigations (which no longer carry
		// the URL flag) skip the Service Worker registration as well.
		`window.localStorage.setItem("octop.desktopShell","1")`,
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("marker script must contain %q", want)
		}
	}

	// The purge must be guarded so it runs once per document.
	if !strings.Contains(script, "window.__octopDesktopSwCleaned") {
		t.Fatal("marker script must guard the purge against repeated runs")
	}

	// A reload during start-up races the shell's own navigation and can leave
	// the window on a blank page. The dashboard skips the registration in the
	// first place, so no reload is needed.
	if strings.Contains(script, "window.location.reload()") {
		t.Fatal("marker script must not reload the window during start-up")
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

// The dashboard must be able to recognise the shell before its first script
// runs, which is why the flag travels with the URL.
func TestWithDesktopURLFlag(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "adds the flag to a plain base",
			in:   "https://ocbot.aixifs.com/videogen",
			want: "https://ocbot.aixifs.com/videogen?desktop=1",
		},
		{
			name: "keeps an existing path",
			in:   "https://ocbot.aixifs.com/videogen/product-library",
			want: "https://ocbot.aixifs.com/videogen/product-library?desktop=1",
		},
		{
			name: "preserves existing query parameters",
			in:   "https://ocbot.aixifs.com/videogen?tab=media",
			want: "https://ocbot.aixifs.com/videogen?desktop=1&tab=media",
		},
		{
			name: "does not add the flag twice",
			in:   "https://ocbot.aixifs.com/videogen?desktop=1",
			want: "https://ocbot.aixifs.com/videogen?desktop=1",
		},
		{
			name: "leaves an empty target alone",
			in:   "",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := withDesktopURLFlag(tc.in); got != tc.want {
				t.Fatalf("withDesktopURLFlag(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
