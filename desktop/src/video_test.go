package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func init() {
	if os.Getenv("OCTOP_TEST_VIDEO_ENV_WORKER") == "1" {
		mode := "check"
		for i := 0; i < len(os.Args); i++ {
			if os.Args[i] == "--verify" {
				mode = "verify"
			}
		}
		time.Sleep(150 * time.Millisecond)
		if mode == "verify" {
			_, _ = fmt.Fprintln(os.Stdout, `{"type":"environment","state":"verifying","stage":"render_test","progress":0.75}`)
			_, _ = fmt.Fprintln(os.Stdout, `{"type":"environment","state":"ready","stage":"render_test","progress":1}`)
			time.Sleep(200 * time.Millisecond)
		} else {
			_, _ = fmt.Fprintln(os.Stdout, `{"type":"environment","state":"checking","stage":"components","progress":0.5}`)
			_, _ = fmt.Fprintln(os.Stdout, `{"type":"environment","state":"needs_setup","stage":"render_test","errorCode":"BROWSER_MISSING"}`)
		}
		os.Exit(0)
	}
	if os.Getenv("OCTOP_TEST_VIDEO_WORKER") != "1" {
		return
	}
	var out string
	for i := 0; i+1 < len(os.Args); i++ {
		if os.Args[i] == "--out" {
			out = os.Args[i+1]
		}
	}
	if out == "" {
		os.Exit(91)
	}
	_, _ = fmt.Fprintln(os.Stdout, `{"type":"stage","stage":"rendering"}`)
	_, _ = fmt.Fprintln(os.Stdout, `{"type":"progress","progress":0.75}`)
	if os.MkdirAll(filepath.Dir(out), 0700) != nil || os.WriteFile(out, []byte("0000ftypisom-fake-mp4"), 0600) != nil {
		os.Exit(92)
	}
	_, _ = fmt.Fprintf(os.Stdout, "{\"type\":\"complete\",\"output\":%q,\"bytes\":21,\"duration\":1}\n", out)
	os.Exit(0)
}

func TestVideoPipelineAgainstHTTPAndFakeWorker(t *testing.T) {
	project := "project_123"
	script := []byte(`{"title":"Demo product","scenes":[{"type":"title"}]}`)
	sum := sha256.Sum256(script)
	manifest, _ := json.Marshal(map[string]any{"schema": "octop-remotion-package/1", "template_version": "1", "project_id": project, "project_name": "Project name", "script_sha256": hex.EncodeToString(sum[:]), "assets": []any{}})
	var packageBuf strings.Builder
	zw := zip.NewWriter(writerAdapter{&packageBuf})
	for name, data := range map[string][]byte{"assets/": {}, "manifest.json": manifest, "script.json": script, "launcher.sh": []byte("must never run"), "renderer/package.json": []byte("untrusted")} {
		w, e := zw.Create(name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = w.Write(data); e != nil {
			t.Fatal(e)
		}
	}
	if e := zw.Close(); e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "auth", 401)
			return
		}
		switch r.URL.Path {
		case "/api/auth/me":
			_, _ = io.WriteString(w, `{"id":42}`)
		case "/api/product-library/projects/" + project + "/storyboard":
			_, _ = fmt.Fprintf(w, `{"confirmed":true,"script":%s}`, script)
		case "/api/product-library/projects/" + project + "/storyboard-package":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = io.WriteString(w, packageBuf.String())
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	root := t.TempDir()
	runtimeDir := filepath.Join(root, "video-runtime")
	if e := os.MkdirAll(runtimeDir, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(runtimeDir, "runtime.json"), []byte(`{"schema":"octop-desktop-video-runtime/1","templateVersion":1}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(runtimeDir, "desktop-worker.mjs"), []byte("// ignored by fake node"), 0600); e != nil {
		t.Fatal(e)
	}
	node := "node"
	if strings.Contains(runtime.GOOS, "windows") {
		node = "node.exe"
	}
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	binary, e := os.ReadFile(exe)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(runtimeDir, node), binary, 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("OCTOP_DESKTOP_VIDEO_RUNTIME", runtimeDir)
	t.Setenv("OCTOP_TEST_VIDEO_WORKER", "1")
	m := newVideoManager(server.URL)
	m.root = filepath.Join(root, "jobs")
	m.environment.State = "ready"
	job, e := m.start("secret", project)
	if e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		got, err := m.get("secret", job.ID)
		if err == nil && got.State == "completed" {
			if got.Name != "Demo product" || got.VideoURL == "" {
				t.Fatalf("unexpected result: %+v", got)
			}
			req, _ := http.NewRequest(http.MethodGet, got.VideoURL, nil)
			req.Header.Set("Range", "bytes=4-7")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusPartialContent || string(data) != "ftyp" {
				t.Fatalf("range response: %d %q", resp.StatusCode, data)
			}
			return
		}
		if got.State == "failed" {
			t.Fatalf("pipeline failed with %s", got.ErrorCode)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("render job did not complete")
}

type writerAdapter struct{ b *strings.Builder }

func (w writerAdapter) Write(p []byte) (int, error) { return w.b.Write(p) }

func TestVideoPackageRejectsTraversalAndBadHash(t *testing.T) {
	for _, name := range []string{"../escape", "assets/../escape"} {
		t.Run(name, func(t *testing.T) {
			buf := new(strings.Builder)
			zw := zip.NewWriter(writerAdapter{buf})
			w, _ := zw.Create(name)
			_, _ = w.Write([]byte("x"))
			_ = zw.Close()
			p := filepath.Join(t.TempDir(), "x.zip")
			_ = os.WriteFile(p, []byte(buf.String()), 0600)
			if _, e := extractVideoPackage(p, filepath.Join(t.TempDir(), "data"), "p"); e == nil {
				t.Fatal("expected invalid ZIP")
			}
		})
	}
}

func TestVideoBridgeJSParses(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is unavailable")
	}
	oldInstallerURL := defaultVideoComponentsURL
	defaultVideoComponentsURL = "javascript:alert(1)"
	defer func() { defaultVideoComponentsURL = oldInstallerURL }()
	script := videoBridgeJS("https://example.test/videogen", "0123456789abcdef")
	if !strings.Contains(script, `environmentVersion:1,environmentInstallerURL:""`) {
		t.Fatal("invalid installer URL was exposed")
	}
	defaultVideoComponentsURL = "HTTPS://components.example.test/octop-video-components.exe"
	script = videoBridgeJS("https://example.test/videogen", "0123456789abcdef")
	if !strings.Contains(script, `environmentInstallerURL:"https://components.example.test/octop-video-components.exe"`) {
		t.Fatal("valid installer URL was not normalized and exposed")
	}
	cmd := exec.Command(node, "-e", "new (require('node:vm').Script)(process.argv[1])", script)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("bridge JavaScript syntax: %v: %s", err, output)
	}
}

func TestSafeVideoNameAndSameFileCopy(t *testing.T) {
	if got := safeVideoName(`bad<>:"/\\|?*name... `); got != "badname" {
		t.Fatalf("safe filename = %q", got)
	}
	path := filepath.Join(t.TempDir(), "movie.mp4")
	want := []byte("keep this video")
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	if err := copyVideo(path, path); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("same-file copy changed contents: %q", got)
	}
}

func TestVideoEnvironmentCheckAndVerifyUseTrustedWorker(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OCTOP_HOME", root)
	runtimeDir := filepath.Join(root, "components")
	if err := os.MkdirAll(runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "runtime.json"), []byte(`{"schema":"octop-desktop-video-runtime/1","templateVersion":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "desktop-worker.mjs"), []byte("// trusted fixture worker"), 0600); err != nil {
		t.Fatal(err)
	}
	node := "node"
	if runtime.GOOS == "windows" {
		node = "node.exe"
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(runtimeDir, node), binary, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOP_DESKTOP_VIDEO_RUNTIME", runtimeDir)
	t.Setenv("OCTOP_TEST_VIDEO_ENV_WORKER", "1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"id":42}`)
	}))
	defer server.Close()
	m := newVideoManager(server.URL)
	status, err := m.environmentAction("secret", "environment_check")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "checking" {
		t.Fatalf("check initial state: %+v", status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, err = m.environmentAction("secret", "environment_status")
		if err != nil {
			t.Fatal(err)
		}
		if status.State == "needs_setup" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status.State != "needs_setup" || status.ErrorCode != "BROWSER_MISSING" {
		t.Fatalf("check result: %+v", status)
	}
	status, err = m.environmentAction("secret", "environment_verify")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "verifying" {
		t.Fatalf("verify initial state: %+v", status)
	}
	time.Sleep(50 * time.Millisecond)
	if status := m.environmentSnapshot(); status.State == "ready" {
		t.Fatal("environment became ready before worker process exited")
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, err = m.environmentAction("secret", "environment_status")
		if err != nil {
			t.Fatal(err)
		}
		if status.State == "ready" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status.State != "ready" || status.CheckedAt == 0 {
		t.Fatalf("verify result: %+v", status)
	}
	if _, err = m.environmentAction("bad-token", "environment_status"); err == nil || err.Error() != "AUTH_REQUIRED" {
		t.Fatalf("unauthenticated status: %v", err)
	}
}

func TestVideoInstallerURLIsHTTPOnly(t *testing.T) {
	for input, want := range map[string]string{"https://example.test/download": "https://example.test/download", "http://example.test/v1": "http://example.test/v1", "file:///tmp/setup": "", "https://user@example.test/setup": "", "https://example.test/setup#fragment": ""} {
		if got := sanitizeEnvironmentInstallerURL(input); got != want {
			t.Errorf("sanitizeEnvironmentInstallerURL(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestVideoEnvironmentMissingRuntimeRequestsComponents(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OCTOP_HOME", root)
	runtimeDir := filepath.Join(root, "empty-components")
	if err := os.MkdirAll(runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOP_DESKTOP_VIDEO_RUNTIME", runtimeDir)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"id":42}`)
	}))
	defer server.Close()
	m := newVideoManager(server.URL)
	status, err := m.environmentAction("secret", "environment_check")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "needs_setup" || status.ErrorCode != "RUNTIME_MISSING" || !status.RequiresInstall {
		t.Fatalf("missing-runtime status: %+v", status)
	}
}

func TestVideoStartRequiresVerifiedEnvironment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			t.Fatalf("unexpected request before environment is ready: %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"id":42}`)
	}))
	defer server.Close()
	m := newVideoManager(server.URL)
	if _, err := m.start("secret", "project_123"); err == nil || err.Error() != "RUNTIME_MISSING" {
		t.Fatalf("start with unknown environment: %v", err)
	}
}

func TestVideoRealRuntimeSmoke(t *testing.T) {
	base, token, project := os.Getenv("OCTOP_VIDEO_SMOKE_BASE"), os.Getenv("OCTOP_VIDEO_SMOKE_TOKEN"), os.Getenv("OCTOP_VIDEO_SMOKE_PROJECT")
	if base == "" || token == "" || project == "" {
		t.Skip("set OCTOP_VIDEO_SMOKE_BASE, OCTOP_VIDEO_SMOKE_TOKEN, and OCTOP_VIDEO_SMOKE_PROJECT")
	}
	t.Setenv("OCTOP_HOME", t.TempDir())
	m := newVideoManager(base)
	status, err := m.environmentAction(token, "environment_check")
	if err != nil {
		t.Fatalf("check rendering environment: %v", err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	for status.State == "checking" && time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		status, err = m.environmentAction(token, "environment_status")
		if err != nil {
			t.Fatal(err)
		}
	}
	if status.State == "needs_setup" {
		status, err = m.environmentAction(token, "environment_verify")
		if err != nil {
			t.Fatalf("verify rendering environment: %v", err)
		}
	}
	deadline = time.Now().Add(2 * time.Minute)
	for (status.State == "verifying" || status.State == "checking") && time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		status, err = m.environmentAction(token, "environment_status")
		if err != nil {
			t.Fatal(err)
		}
	}
	if status.State != "ready" {
		t.Fatalf("rendering environment is %s (%s)", status.State, status.ErrorCode)
	}
	job, err := m.start(token, project)
	if err != nil {
		t.Fatalf("start video job: %v", err)
	}
	defer m.interrupt()
	deadline = time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		current, err := m.get(token, job.ID)
		if err != nil {
			t.Fatalf("get video job: %v", err)
		}
		switch current.State {
		case "completed":
			req, err := http.NewRequest(http.MethodGet, current.VideoURL, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Range", "bytes=0-11")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != http.StatusPartialContent {
				_ = resp.Body.Close()
				t.Fatalf("video stream returned %s", resp.Status)
			}
			header, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if readErr != nil || len(header) != 12 || string(header[4:8]) != "ftyp" {
				t.Fatalf("video Range header is not an MP4 ftyp box: bytes=%d err=%v", len(header), readErr)
			}
			m.mu.Lock()
			output := m.jobs[job.ID].Output
			m.mu.Unlock()
			info, err := os.Stat(output)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("native runtime rendered %d bytes", info.Size())
			return
		case "failed":
			t.Fatalf("native runtime failed with %s", current.ErrorCode)
		case "cancelled", "interrupted":
			t.Fatalf("native runtime ended in %s", current.State)
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("native runtime smoke timed out after 120 seconds")
}

// TestVideoPackageKeepsAudioPlan proves the optional audio.json survives the
// extraction: the client needs it to synthesise the free-tier narration.
func TestVideoPackageKeepsAudioPlan(t *testing.T) {
	buf := new(strings.Builder)
	zw := zip.NewWriter(writerAdapter{buf})
	script := []byte(`{"title":"Camera","scenes":[{"id":"s1","type":"title","duration":2}]}`)
	sum := sha256.Sum256(script)
	w, _ := zw.Create("script.json")
	_, _ = w.Write(script)
	w, _ = zw.Create("manifest.json")
	_, _ = w.Write([]byte(`{"schema":"octop-remotion-package/1","template_version":"1","project_id":"p","script_sha256":"` + hex.EncodeToString(sum[:]) + `","assets":[]}`))
	w, _ = zw.Create("audio.json")
	_, _ = w.Write([]byte(`{"narration":{"mode":"local"},"scenes":{"s1":{"narration":"hi"}}}`))
	_ = zw.Close()
	p := filepath.Join(t.TempDir(), "x.zip")
	if err := os.WriteFile(p, []byte(buf.String()), 0600); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "data")
	if _, err := extractVideoPackage(p, dest, "p"); err != nil {
		t.Fatalf("extract: %v", err)
	}
	plan, err := os.ReadFile(filepath.Join(dest, "audio.json"))
	if err != nil {
		t.Fatalf("audio.json was not extracted: %v", err)
	}
	if !strings.Contains(string(plan), `"mode":"local"`) {
		t.Fatalf("unexpected audio plan: %s", plan)
	}
}
