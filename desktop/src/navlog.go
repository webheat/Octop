package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// navProbeJS is the script injected into every document the shell loads. It
// reports the document URL, content type, SPA route changes, failed requests
// and uncaught errors back to the loopback endpoint started here.
//
//go:embed navprobe.js
var navProbeJS string

// navLogMaxSize caps the log file; on startup a bigger file is rotated once.
const navLogMaxSize = 4 << 20

// navLogFileName is the log written next to the running executable, so a
// portable install keeps all diagnostics in its own directory.
const navLogFileName = "desktop-nav.log"

// navLogger collects what the webview actually navigates to.
//
// The shell has no API for "which URL did the webview load" — the Wails window
// only reports that *a* navigation completed. Without this, a 404 after login
// is invisible from the outside: the window shows an error page and nothing in
// any log says which address produced it.
type navLogger struct {
	mu       sync.Mutex
	logger   *log.Logger
	file     *os.File
	endpoint string
	once     sync.Once
}

var navLog = &navLogger{}

// navLogf appends one line to the navigation log (and stderr when there is no
// file yet, so early boot problems are still visible).
func navLogf(format string, args ...any) {
	navLog.logf(format, args...)
}

func (n *navLogger) logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	n.mu.Lock()
	logger := n.logger
	n.mu.Unlock()
	if logger == nil {
		log.Printf("nav: %s", msg)
		return
	}
	logger.Printf("%s", msg)
}

// path returns the log file location.
//
// The log lives next to the running executable (not under the user home) so
// portable/green installs keep all diagnostics self-contained. Falls back to
// octopHome() only when the executable path cannot be determined.
func navLogPath() string {
	if exe, err := os.Executable(); err == nil && exe != "" {
		return filepath.Join(filepath.Dir(exe), navLogFileName)
	}
	return filepath.Join(octopHome(), "logs", navLogFileName)
}

// navLogDisabled reports whether the operator switched the navigation log off.
// It is on by default: without it a shell showing an error page leaves no
// evidence of which address produced it.
func navLogDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OCTOP_DESKTOP_NAVLOG"))) {
	case "0", "false", "off", "no":
		return true
	}
	return false
}

// start opens the log file, writes a session header and starts the loopback
// collector. It is safe to call more than once.
func (n *navLogger) start() {
	if navLogDisabled() {
		return
	}
	n.once.Do(func() {
		path := navLogPath()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			log.Printf("nav log: create dir: %v", err)
			return
		}
		if info, err := os.Stat(path); err == nil && info.Size() > navLogMaxSize {
			_ = os.Rename(path, path+".1")
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			log.Printf("nav log: open: %v", err)
			return
		}
		n.mu.Lock()
		n.file = file
		n.logger = log.New(file, "", log.LstdFlags|log.Lmicroseconds)
		n.mu.Unlock()
		n.logf("=== session start pid=%d goos=%s exe=%s", os.Getpid(), runtime.GOOS, exePath())
		n.startServer()
	})
}

// close flushes and releases the log file.
func (n *navLogger) close() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.file != nil {
		_ = n.file.Close()
		n.file = nil
		n.logger = nil
	}
}

// startServer listens on a random loopback port; the probe posts to it.
//
// A loopback listener is used instead of a Wails binding because the window
// loads a *remote* origin: the generated JS bindings only exist on pages the
// asset server serves, while a plain HTTP POST works from any document.
func (n *navLogger) startServer() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		n.logf("probe endpoint unavailable: %v", err)
		return
	}
	n.mu.Lock()
	n.endpoint = fmt.Sprintf("http://127.0.0.1:%d/log", listener.Addr().(*net.TCPAddr).Port)
	endpoint := n.endpoint
	n.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/log", n.handle)
	go func() {
		server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			n.logf("probe endpoint stopped: %v", err)
		}
	}()
	n.logf("probe endpoint %s", endpoint)
}

// endpointURL returns the loopback collector URL, or "" when it is not up.
func (n *navLogger) endpointURL() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.endpoint
}

// corsHeaders makes the loopback endpoint reachable from the remote page the
// webview loads. The page is https, the endpoint is loopback http: allowed as
// potentially-trustworthy, but the browser still preflights, and Chromium's
// private-network check wants the extra header.
func (n *navLogger) corsHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Access-Control-Max-Age", "600")
}

func (n *navLogger) handle(w http.ResponseWriter, r *http.Request) {
	n.corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var raw []byte
	if r.Method == http.MethodGet {
		// Fallback path (sendBeacon / <img>): no CORS preflight involved.
		if d := r.URL.Query().Get("d"); d != "" {
			raw = []byte(d)
		}
	} else {
		raw, _ = io.ReadAll(io.LimitReader(r.Body, 64<<10))
	}
	w.WriteHeader(http.StatusNoContent)
	if len(raw) == 0 {
		return
	}
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		n.logf("[probe-raw] %s", clip(string(raw), 400))
		return
	}
	n.logf("%s", formatNavEvent(event))
}

// formatNavEvent renders one probe event as a single readable line.
func formatNavEvent(event map[string]any) string {
	kind := navField(event, "kind")
	if kind == "" {
		kind = "probe"
	}
	parts := []string{"[" + kind + "]"}
	appendField := func(name string, value string) {
		if value != "" {
			parts = append(parts, name+"="+value)
		}
	}
	appendField("url", redactURL(navField(event, "href")))
	appendField("target", redactURL(navField(event, "url")))
	if method := navField(event, "method"); method != "" {
		appendField("method", method)
	}
	if status, ok := event["status"]; ok {
		parts = append(parts, fmt.Sprintf("status=%v", status))
	}
	if title := navField(event, "title"); title != "" && title != "Octop" {
		appendField("title", quoteField(title))
	}
	appendField("ctype", navField(event, "ctype"))
	appendField("ready", navField(event, "ready"))
	if referrer := navField(event, "referrer"); referrer != "" && referrer != navField(event, "href") {
		appendField("referrer", redactURL(referrer))
	}
	if source := navField(event, "source"); source != "" {
		appendField("source", redactURL(source))
	}
	if winName := navField(event, "winName"); winName != "" {
		appendField("win", quoteField(winName))
	}
	if msg := navField(event, "error"); msg != "" {
		appendField("error", quoteField(clip(msg, 300)))
	}
	if body := navField(event, "body"); body != "" {
		appendField("body", quoteField(clip(body, 400)))
	}
	// Any remaining keys (future probes) are appended verbatim.
	extra := make([]string, 0, len(event))
	for key := range event {
		switch key {
		case "kind", "seq", "href", "url", "method", "status", "title", "ctype",
			"ready", "referrer", "source", "winName", "error", "body", "ts":
			continue
		}
		extra = append(extra, fmt.Sprintf("%s=%v", key, event[key]))
	}
	sort.Strings(extra)
	parts = append(parts, extra...)
	return strings.Join(parts, " ")
}

// navField reads a string field, tolerating numbers and nulls.
func navField(event map[string]any, key string) string {
	value, ok := event[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return fmt.Sprintf("%g", typed)
	case bool:
		return fmt.Sprintf("%t", typed)
	default:
		return ""
	}
}

// quoteField makes free-form values (page text, error messages) stay on one
// line and visibly delimited.
func quoteField(value string) string {
	value = strings.ReplaceAll(value, `"`, `'`)
	return `"` + clip(value, 400) + `"`
}

// clip shortens a value, keeping the head (the part that identifies it).
func clip(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

// sensitiveQueryParams are redacted before anything reaches the log: URLs the
// login flow hands around carry one-time credentials.
var sensitiveQueryParams = map[string]bool{
	"token":         true,
	"access_token":  true,
	"refresh_token": true,
	"id_token":      true,
	"code":          true,
	"state":         true,
	"password":      true,
	"secret":        true,
	"ticket":        true,
	"session":       true,
	"key":           true,
	"sig":           true,
	"signature":     true,
}

// redactURL keeps the shape of a URL (scheme, host, path, parameter names) but
// drops the value of every credential-shaped query parameter. The point of the
// log is to see *which* address a 404 came from, not to archive login tokens.
func redactURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.RawQuery == "" {
		return raw
	}
	query := parsed.Query()
	changed := false
	for key, values := range query {
		if !sensitiveQueryParams[strings.ToLower(key)] {
			continue
		}
		redacted := make([]string, len(values))
		for i, value := range values {
			redacted[i] = fmt.Sprintf("<redacted:%d>", len(value))
		}
		query[key] = redacted
		changed = true
	}
	if !changed {
		return raw
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// navProbeScript returns the probe with its endpoint baked in.
func navProbeScript(endpoint string) string {
	encoded, err := json.Marshal(endpoint)
	if err != nil {
		encoded = []byte(`""`)
	}
	return strings.ReplaceAll(navProbeJS, "__OCTOP_NAVLOG_ENDPOINT__", string(encoded))
}

// armNavigationLog starts the log file plus collector and injects the probe
// into every document the window loads.
//
// The injection rides on the same platform events the drag overlay uses, so it
// runs once per completed navigation — that is exactly when a new document
// exists and the previous probe (if any) is gone.
func armNavigationLog(win *application.WebviewWindow) {
	navLog.start()
	if win == nil {
		return
	}
	endpoint := navLog.endpointURL()
	if endpoint == "" {
		navLogf("probe injection skipped: no endpoint")
		return
	}
	script := navProbeScript(endpoint)
	inject := func() {
		// Go-side marker: it lands even when the document forbids the probe's
		// request (CSP / blocked network), which separates "no navigation
		// happened" from "navigation happened but the page stayed silent".
		navLogf("navigation completed, injecting probe")
		win.ExecJS(script)
	}
	inject()
	win.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(_ *application.WindowEvent) { inject() })
	win.OnWindowEvent(events.Mac.WebViewDidFinishNavigation, func(_ *application.WindowEvent) { inject() })
	win.OnWindowEvent(events.Linux.WindowLoadFinished, func(_ *application.WindowEvent) { inject() })
}

// exePath reports where this shell was launched from; two builds (old and
// freshly compiled) write to the same log, so the path identifies which one
// produced the lines.
func exePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "?"
	}
	return exe
}
