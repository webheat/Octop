package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNavLogPathIsBesideExecutable(t *testing.T) {
	got := navLogPath()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	want := filepath.Join(filepath.Dir(exe), navLogFileName)
	if got != want {
		t.Fatalf("navLogPath() = %q, want %q (log must live beside the exe, not in user home)", got, want)
	}
	if strings.Contains(got, string(os.PathSeparator)+".octop"+string(os.PathSeparator)) {
		t.Fatalf("navLogPath() = %q must not point into the user home", got)
	}
}

func TestRedactURLMasksCredentialParams(t *testing.T) {
	got := redactURL("https://ocbot.aixifs.com/login?token=abcdef123456&next=%2Fchat")
	if strings.Contains(got, "abcdef123456") {
		t.Fatalf("token value leaked: %s", got)
	}
	if !strings.Contains(got, "token=%3Credacted%3A12%3E") && !strings.Contains(got, "token=<redacted:12>") {
		t.Fatalf("token should be redacted with its length: %s", got)
	}
	if !strings.Contains(got, "next=") {
		t.Fatalf("non-sensitive params must survive: %s", got)
	}
	if !strings.Contains(got, "ocbot.aixifs.com/login") {
		t.Fatalf("scheme/host/path must survive: %s", got)
	}
}

func TestRedactURLLeavesCleanURLsAlone(t *testing.T) {
	for _, raw := range []string{
		"",
		"https://ocbot.aixifs.com/videogen/product-library",
		"https://ocbot.aixifs.com/videogen/?lang=zh",
	} {
		if got := redactURL(raw); got != raw {
			t.Fatalf("redactURL(%q) = %q, want unchanged", raw, got)
		}
	}
}

func TestFormatNavEventRendersDiagnostics(t *testing.T) {
	line := formatNavEvent(map[string]any{
		"kind":   "nav",
		"href":   "https://ocbot.aixifs.com/videogen/product-library?token=secret-token",
		"title":  "Not Found",
		"ctype":  "text/html",
		"body":   "404 page not found",
		"status": float64(404),
	})
	for _, want := range []string{"[nav]", "product-library", "ctype=text/html", "status=404", `body="404 page not found"`} {
		if !strings.Contains(line, want) {
			t.Fatalf("line %q missing %q", line, want)
		}
	}
	if strings.Contains(line, "secret-token") {
		t.Fatalf("query token leaked into log line: %s", line)
	}
}

func TestNavProbeScriptBakesEndpoint(t *testing.T) {
	script := navProbeScript("http://127.0.0.1:12345/log")
	if strings.Contains(script, "__OCTOP_NAVLOG_ENDPOINT__") {
		t.Fatal("placeholder was not replaced")
	}
	if !strings.Contains(script, `"http://127.0.0.1:12345/log"`) {
		t.Fatal("endpoint must be baked in as a JS string literal")
	}
}

func TestNavLogHandlerAcceptsPostAndPreflight(t *testing.T) {
	logger := &navLogger{}

	preflight := httptest.NewRecorder()
	logger.handle(preflight, httptest.NewRequest(http.MethodOptions, "/log", nil))
	if preflight.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", preflight.Code)
	}
	if got := preflight.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
	if got := preflight.Header().Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("Access-Control-Allow-Private-Network = %q", got)
	}

	body := `{"kind":"nav","href":"https://ocbot.aixifs.com/videogen/","ctype":"text/html"}`
	post := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/log", strings.NewReader(body))
	logger.handle(post, request)
	if post.Code != http.StatusNoContent {
		t.Fatalf("post status = %d, want 204", post.Code)
	}
}

func TestNavLogHandlerAcceptsBeaconFallback(t *testing.T) {
	logger := &navLogger{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/log?d="+`{"kind":"unload","href":"https://x.test/a"}`, nil)
	logger.handle(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("beacon status = %d, want 204", recorder.Code)
	}
}

func TestNavLogDisabledByEnv(t *testing.T) {
	for _, off := range []string{"0", "false", "OFF", " no "} {
		t.Setenv("OCTOP_DESKTOP_NAVLOG", off)
		if !navLogDisabled() {
			t.Fatalf("value %q should disable the navigation log", off)
		}
	}
	t.Setenv("OCTOP_DESKTOP_NAVLOG", "")
	if navLogDisabled() {
		t.Fatal("navigation log must be on by default")
	}
}

func TestNavProbeReportsNonHTMLDocuments(t *testing.T) {
	script := navProbeScript("http://127.0.0.1:1/log")
	// A JSON/text document means a proxy or API error page — the probe must
	// capture its body, otherwise a 404 is indistinguishable from a page.
	if !strings.Contains(script, "indexOf(\"html\") === -1") {
		t.Fatal("probe must detect non-HTML documents")
	}
	if !strings.Contains(script, "beforeunload") {
		t.Fatal("probe must report the document it navigates away from")
	}
}
