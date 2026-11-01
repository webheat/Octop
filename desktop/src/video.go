package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const videoPackageLimit = 2 << 30

type VideoJob struct {
	ID        string   `json:"id"`
	ProjectID string   `json:"projectId"`
	OwnerID   string   `json:"ownerId"`
	Name      string   `json:"name"`
	State     string   `json:"state"`
	Progress  *float64 `json:"progress"`
	ErrorCode string   `json:"errorCode,omitempty"`
	VideoURL  string   `json:"videoUrl,omitempty"`
	UpdatedAt int64    `json:"updatedAt"`
}

type videoManifest struct {
	Schema          string `json:"schema"`
	TemplateVersion string `json:"template_version"`
	ProjectID       string `json:"project_id"`
	ProjectName     string `json:"project_name"`
	ScriptSHA       string `json:"script_sha256"`
	Assets          []struct {
		Path  string `json:"path"`
		SHA   string `json:"sha256"`
		Bytes int64  `json:"bytes"`
	} `json:"assets"`
}
type videoScript struct {
	Title  string `json:"title"`
	Scenes []struct {
		Asset string `json:"asset"`
	} `json:"scenes"`
}

// audioPlan mirrors the optional audio.json that ships beside script.json.
//
// It is kept separate from the script on purpose: the script hash the server
// confirmed must not change, so timing overrides and track references travel
// in their own file.
type audioPlan struct {
	BGM struct {
		Src string  `json:"src"`
		Bar float64 `json:"bar"`
	} `json:"bgm"`
	Narration struct {
		Mode    string `json:"mode"`
		VoiceID string `json:"voiceId"`
	} `json:"narration"`
	Scenes map[string]struct {
		Duration  float64 `json:"duration"`
		Narration string  `json:"narration"`
		Audio     struct {
			Src string `json:"src"`
		} `json:"audio"`
	} `json:"scenes"`
}
type runtimeManifest struct {
	Schema          string `json:"schema"`
	TemplateVersion int    `json:"templateVersion"`
}

type videoJobRecord struct {
	Job        VideoJob `json:"job"`
	DataDir    string   `json:"dataDir"`
	Output     string   `json:"output"`
	Capability string   `json:"capability"`
	ScriptHash string   `json:"scriptHash"`
}
type videoManager struct {
	mu                 sync.Mutex
	base               string
	root               string
	client             *http.Client
	jobs               map[string]*videoJobRecord
	loaded             map[string]bool
	active             string
	cmd                *exec.Cmd
	cmdJob             string
	stdin              io.WriteCloser
	cancelRender       context.CancelFunc
	cancelJob          string
	environment        VideoEnvironmentStatus
	environmentRunning bool
	environmentMode    string
	environmentCmd     *exec.Cmd
	environmentStdin   io.WriteCloser
	environmentLogKey  string
	listener           net.Listener
	server             *http.Server
}

func newVideoManager(base string) *videoManager {
	root := filepath.Join(octopHome(), "desktop-video-jobs")
	baseURL, _ := url.Parse(base)
	serverScope := "invalid-server"
	if baseURL != nil {
		serverScope = baseURL.Scheme + "://" + strings.ToLower(baseURL.Host) + strings.TrimRight(baseURL.EscapedPath(), "/")
	}
	serverHash := sha256.Sum256([]byte(serverScope))
	root = filepath.Join(root, hex.EncodeToString(serverHash[:]))
	return &videoManager{base: strings.TrimRight(base, "/"), root: root, client: &http.Client{}, jobs: map[string]*videoJobRecord{}, loaded: map[string]bool{}, environment: VideoEnvironmentStatus{State: "unknown"}}
}

func (m *videoManager) apiURL(path string) string { return m.base + "/api" + path }
func (m *videoManager) request(ctx context.Context, method, path, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, m.apiURL(path), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return m.client.Do(req)
}
func (m *videoManager) owner(ctx context.Context, token string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	r, err := m.request(ctx, http.MethodGet, "/auth/me", token)
	if err != nil {
		return "", videoErr("INTERNAL")
	}
	defer r.Body.Close()
	if r.StatusCode == 401 || r.StatusCode == 403 {
		return "", videoErr("AUTH_REQUIRED")
	}
	if r.StatusCode != 200 {
		return "", videoErr("INTERNAL")
	}
	var who struct {
		ID json.RawMessage `json:"id"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&who) != nil || len(who.ID) == 0 {
		return "", videoErr("AUTH_REQUIRED")
	}
	var id string
	if json.Unmarshal(who.ID, &id) != nil {
		var n json.Number
		d := json.NewDecoder(bytes.NewReader(who.ID))
		d.UseNumber()
		if d.Decode(&n) != nil {
			return "", videoErr("AUTH_REQUIRED")
		}
		id = n.String()
	}
	if id == "" {
		return "", videoErr("AUTH_REQUIRED")
	}
	return id, nil
}

func (m *videoManager) confirmedScriptHash(token, project string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	path := "/product-library/projects/" + url.PathEscape(project) + "/storyboard"
	r, err := m.request(ctx, http.MethodGet, path, token)
	if err != nil {
		return "", videoErr("INTERNAL")
	}
	defer r.Body.Close()
	if r.StatusCode == http.StatusUnauthorized || r.StatusCode == http.StatusForbidden {
		return "", videoErr("AUTH_REQUIRED")
	}
	if r.StatusCode == http.StatusNotFound {
		return "", videoErr("NOT_FOUND")
	}
	if r.StatusCode != http.StatusOK {
		return "", videoErr("INTERNAL")
	}
	var draft struct {
		Confirmed bool            `json:"confirmed"`
		Script    json.RawMessage `json:"script"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&draft) != nil || len(draft.Script) == 0 {
		return "", videoErr("PLAN_CHANGED")
	}
	if !draft.Confirmed {
		return "", videoErr("PLAN_NOT_CONFIRMED")
	}
	return semanticScriptHash(draft.Script)
}
func semanticScriptHash(raw []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if dec.Decode(&value) != nil {
		return "", videoErr("PLAN_CHANGED")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return "", videoErr("PLAN_CHANGED")
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}
func videoErr(code string) error { return errors.New(code) }
func validProjectID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func (m *videoManager) dir(owner string) string {
	sum := sha256.Sum256([]byte(owner))
	return filepath.Join(m.root, hex.EncodeToString(sum[:]))
}
func (m *videoManager) load(owner string) {
	m.mu.Lock()
	if m.loaded[owner] {
		m.mu.Unlock()
		return
	}
	m.loaded[owner] = true
	m.mu.Unlock()
	dir := m.dir(owner)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var rec videoJobRecord
		if json.Unmarshal(b, &rec) != nil || rec.Job.OwnerID != owner {
			continue
		}
		switch rec.Job.State {
		case "preparing", "downloading", "rendering", "saving":
			rec.Job.State = "interrupted"
			rec.Job.Progress = nil
			rec.Job.ErrorCode = "RENDER_FAILED"
			rec.Job.UpdatedAt = time.Now().Unix()
		}
		m.mu.Lock()
		if rec.Job.State == "interrupted" {
			m.persistLocked(&rec)
		}
		m.jobs[rec.Job.ID] = &rec
		m.mu.Unlock()
	}
}
func (m *videoManager) persistLocked(rec *videoJobRecord) {
	_ = os.MkdirAll(m.dir(rec.Job.OwnerID), 0700)
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	tmp := filepath.Join(m.dir(rec.Job.OwnerID), rec.Job.ID+".tmp")
	if os.WriteFile(tmp, b, 0600) == nil {
		_ = os.Rename(tmp, filepath.Join(m.dir(rec.Job.OwnerID), rec.Job.ID+".json"))
	}
}
func (m *videoManager) snapshot(rec *videoJobRecord) VideoJob {
	j := rec.Job
	if j.State == "completed" && rec.Capability != "" && m.listener != nil {
		j.VideoURL = fmt.Sprintf("http://%s/video/%s/%s", m.listener.Addr().String(), j.ID, rec.Capability)
	} else {
		j.VideoURL = ""
	}
	return j
}
func (m *videoManager) list(token string) ([]VideoJob, error) {
	owner, err := m.owner(context.Background(), token)
	if err != nil {
		return nil, err
	}
	m.load(owner)
	m.ensureStream()
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []VideoJob{}
	for _, r := range m.jobs {
		if r.Job.OwnerID == owner {
			out = append(out, m.snapshot(r))
		}
	}
	return out, nil
}
func (m *videoManager) get(token, id string) (VideoJob, error) {
	owner, err := m.owner(context.Background(), token)
	if err != nil {
		return VideoJob{}, err
	}
	m.load(owner)
	m.ensureStream()
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.jobs[id]
	if r == nil || r.Job.OwnerID != owner {
		return VideoJob{}, videoErr("NOT_FOUND")
	}
	return m.snapshot(r), nil
}

func (m *videoManager) start(token, project string) (VideoJob, error) {
	if !validProjectID(project) {
		return VideoJob{}, videoErr("NOT_FOUND")
	}
	owner, err := m.owner(context.Background(), token)
	if err != nil {
		return VideoJob{}, err
	}
	status := m.environmentSnapshot()
	if status.State != "ready" {
		if status.State == "checking" || status.State == "verifying" {
			return VideoJob{}, videoErr("BUSY")
		}
		if status.State == "failed" && status.ErrorCode != "" {
			return VideoJob{}, videoErr(status.ErrorCode)
		}
		return VideoJob{}, videoErr("RUNTIME_MISSING")
	}
	scriptHash, err := m.confirmedScriptHash(token, project)
	if err != nil {
		return VideoJob{}, err
	}
	m.load(owner)
	m.mu.Lock()
	if m.environmentRunning && m.environmentMode == "verify" {
		m.mu.Unlock()
		return VideoJob{}, videoErr("BUSY")
	}
	if m.active != "" {
		r := m.jobs[m.active]
		if r != nil && r.Job.OwnerID == owner && r.Job.ProjectID == project && r.ScriptHash == scriptHash {
			j := m.snapshot(r)
			m.mu.Unlock()
			return j, nil
		}
		m.mu.Unlock()
		return VideoJob{}, videoErr("BUSY")
	}
	for _, r := range m.jobs {
		if r.Job.OwnerID == owner && r.Job.ProjectID == project && r.Job.State == "completed" && r.ScriptHash == scriptHash {
			j := m.snapshot(r)
			m.mu.Unlock()
			return j, nil
		}
	}
	id, err := randomToken()
	if err != nil {
		m.mu.Unlock()
		return VideoJob{}, videoErr("INTERNAL")
	}
	rec := &videoJobRecord{Job: VideoJob{ID: id, ProjectID: project, OwnerID: owner, Name: "视频", State: "preparing", UpdatedAt: time.Now().Unix()}, ScriptHash: scriptHash}
	m.jobs[id] = rec
	m.active = id
	m.persistLocked(rec)
	m.mu.Unlock()
	job := rec.Job
	go m.run(rec, token)
	return job, nil
}
func (m *videoManager) update(rec *videoJobRecord, state, code string, progress *float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.Job.State == "cancelled" || rec.Job.State == "interrupted" {
		return
	}
	rec.Job.State = state
	rec.Job.ErrorCode = code
	rec.Job.Progress = progress
	rec.Job.UpdatedAt = time.Now().Unix()
	m.persistLocked(rec)
}
func (m *videoManager) fail(rec *videoJobRecord, code string) {
	m.mu.Lock()
	if rec.Job.State != "cancelled" && rec.Job.State != "interrupted" {
		rec.Job.State = "failed"
		rec.Job.ErrorCode = code
		rec.Job.Progress = nil
		rec.Job.UpdatedAt = time.Now().Unix()
		m.persistLocked(rec)
	}
	m.mu.Unlock()
}

func (m *videoManager) finish(rec *videoJobRecord) {
	m.mu.Lock()
	if m.cmdJob == rec.Job.ID {
		m.cmd = nil
		m.stdin = nil
		m.cmdJob = ""
	}
	if m.cancelJob == rec.Job.ID {
		m.cancelRender = nil
		m.cancelJob = ""
	}
	if m.active == rec.Job.ID {
		m.active = ""
	}
	m.mu.Unlock()
}

func (m *videoManager) interrupt() {
	m.mu.Lock()
	var rec *videoJobRecord
	if m.active != "" {
		rec = m.jobs[m.active]
	}
	cancel, cmd := m.cancelRender, m.cmd
	if rec != nil {
		rec.Job.State = "interrupted"
		rec.Job.ErrorCode = "RENDER_FAILED"
		rec.Job.Progress = nil
		rec.Job.UpdatedAt = time.Now().Unix()
		m.persistLocked(rec)
	}
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if cmd != nil {
		killVideoProcessTree(cmd)
	}
	if m.server != nil {
		_ = m.server.Close()
	}
}

func (m *videoManager) run(rec *videoJobRecord, token string) {
	defer m.finish(rec)
	m.mu.Lock()
	if rec.Job.State == "cancelled" || rec.Job.State == "interrupted" {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
	m.update(rec, "downloading", "", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	m.mu.Lock()
	if rec.Job.State == "cancelled" || rec.Job.State == "interrupted" {
		m.mu.Unlock()
		return
	}
	m.cancelRender = cancel
	m.cancelJob = rec.Job.ID
	m.mu.Unlock()
	path := "/product-library/projects/" + url.PathEscape(rec.Job.ProjectID) + "/storyboard-package"
	resp, err := m.request(ctx, http.MethodGet, path, token)
	if err != nil {
		m.fail(rec, "DOWNLOAD_FAILED")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 409 {
		m.fail(rec, "PLAN_NOT_CONFIRMED")
		return
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		m.fail(rec, "AUTH_REQUIRED")
		return
	}
	if resp.StatusCode != 200 {
		m.fail(rec, "DOWNLOAD_FAILED")
		return
	}
	if err = os.MkdirAll(filepath.Join(m.dir(rec.Job.OwnerID), rec.Job.ID), 0700); err != nil {
		m.fail(rec, "INTERNAL")
		return
	}
	jobDir := filepath.Join(m.dir(rec.Job.OwnerID), rec.Job.ID)
	zipPath := filepath.Join(jobDir, "package.zip")
	f, err := os.OpenFile(zipPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		m.fail(rec, "INTERNAL")
		return
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, videoPackageLimit+1))
	closeErr := f.Close()
	if err != nil || closeErr != nil || n > videoPackageLimit {
		m.fail(rec, "DOWNLOAD_FAILED")
		return
	}
	dataDir := filepath.Join(jobDir, "data")
	meta, err := extractVideoPackage(zipPath, dataDir, rec.Job.ProjectID)
	_ = os.Remove(zipPath)
	if err != nil {
		m.fail(rec, "PACKAGE_INVALID")
		return
	}
	scriptBytes, err := os.ReadFile(filepath.Join(dataDir, "script.json"))
	if err != nil {
		m.fail(rec, "PACKAGE_INVALID")
		return
	}
	actualHash, err := semanticScriptHash(scriptBytes)
	if err != nil || actualHash != rec.ScriptHash {
		m.fail(rec, "PLAN_CHANGED")
		return
	}
	// The free tier receives narration lines without audio; synthesise them
	// locally before the renderer starts. Failures are not fatal — the video
	// still renders, just without the voice.
	_ = synthesizeLocalNarration(dataDir)
	rec.DataDir = dataDir
	rec.Job.Name = meta
	m.mu.Lock()
	m.persistLocked(rec)
	m.mu.Unlock()
	runtimeDir, err := videoRuntimeDir()
	if err != nil {
		m.fail(rec, "RUNTIME_MISSING")
		return
	}
	if err = startVideoWorker(m, rec, runtimeDir); err != nil {
		if rec.Job.State != "cancelled" && rec.Job.State != "interrupted" {
			m.fail(rec, videoErrorCode(err))
		}
		return
	}
}

func videoRuntimeDir() (string, error) {
	if p := os.Getenv("OCTOP_DESKTOP_VIDEO_RUNTIME"); p != "" {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p, nil
		}
	}
	if cache, err := os.UserCacheDir(); err == nil {
		candidate := filepath.Join(cache, "Octop", "video-runtime")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate, nil
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(filepath.Dir(exe), "video-runtime")
	if st, err := os.Stat(candidate); err == nil && st.IsDir() {
		return candidate, nil
	}
	return "", videoErr("RUNTIME_MISSING")
}
func extractVideoPackage(zipPath, dest, project string) (string, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", err
	}
	defer zr.Close()
	if err = os.MkdirAll(dest, 0700); err != nil {
		return "", err
	}
	entries := map[string]*zip.File{}
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		clean := filepath.ToSlash(filepath.Clean(name))
		checkedName := strings.TrimSuffix(name, "/")
		if strings.HasPrefix(name, "/") || clean == ".." || strings.HasPrefix(clean, "../") || clean != checkedName || f.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("unsafe archive")
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if _, ok := entries[name]; ok {
			return "", fmt.Errorf("duplicate entry")
		}
		entries[name] = f
	}
	read := func(name string, limit int64) ([]byte, error) {
		f := entries[name]
		if f == nil {
			return nil, fmt.Errorf("missing file")
		}
		r, e := f.Open()
		if e != nil {
			return nil, e
		}
		defer r.Close()
		return io.ReadAll(io.LimitReader(r, limit+1))
	}
	mb, err := read("manifest.json", 1<<20)
	if err != nil {
		return "", err
	}
	var m videoManifest
	if json.Unmarshal(mb, &m) != nil || m.Schema != "octop-remotion-package/1" || m.TemplateVersion != "1" || m.ProjectID != project || m.ScriptSHA == "" {
		return "", fmt.Errorf("invalid manifest")
	}
	sb, err := read("script.json", 8<<20)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(sb)
	if hex.EncodeToString(sum[:]) != m.ScriptSHA {
		return "", fmt.Errorf("script hash")
	}
	var script videoScript
	if json.Unmarshal(sb, &script) != nil || len(script.Scenes) == 0 {
		return "", fmt.Errorf("invalid script")
	}
	assets := map[string]struct {
		sha  string
		size int64
	}{}
	for _, a := range m.Assets {
		if !strings.HasPrefix(a.Path, "assets/") || a.Path == "assets/" || strings.Contains(a.Path, "..") || a.Bytes < 0 || a.Bytes > videoPackageLimit {
			return "", fmt.Errorf("invalid asset path")
		}
		if _, ok := assets[a.Path]; ok {
			return "", fmt.Errorf("duplicate asset")
		}
		assets[a.Path] = struct {
			sha  string
			size int64
		}{a.SHA, a.Bytes}
	}
	for _, scene := range script.Scenes {
		if scene.Asset != "" {
			if _, ok := assets["assets/"+filepath.ToSlash(scene.Asset)]; !ok {
				return "", fmt.Errorf("unlisted asset reference")
			}
		}
	}
	for name, f := range entries {
		if name != "script.json" && name != "manifest.json" && name != "audio.json" && !strings.HasPrefix(name, "assets/") {
			continue
		}
		if strings.HasPrefix(name, "assets/") {
			a, ok := assets[name]
			if !ok {
				return "", fmt.Errorf("unlisted asset")
			}
			r, e := f.Open()
			if e != nil {
				return "", e
			}
			outPath := filepath.Join(dest, filepath.FromSlash(name))
			if e = os.MkdirAll(filepath.Dir(outPath), 0700); e != nil {
				r.Close()
				return "", e
			}
			out, e := os.OpenFile(outPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				r.Close()
				return "", e
			}
			h := sha256.New()
			size, e := io.Copy(io.MultiWriter(out, h), io.LimitReader(r, a.size+1))
			r.Close()
			out.Close()
			if e != nil || size != a.size || hex.EncodeToString(h.Sum(nil)) != a.sha {
				return "", fmt.Errorf("asset validation")
			}
			continue
		}
		b, e := read(name, 8<<20)
		if e != nil {
			return "", e
		}
		if e = os.WriteFile(filepath.Join(dest, name), b, 0600); e != nil {
			return "", e
		}
	}
	name := strings.TrimSpace(script.Title)
	if name == "" {
		name = strings.TrimSpace(m.ProjectName)
	}
	if name == "" {
		name = "视频"
	}
	return name, nil
}

func startVideoWorker(m *videoManager, rec *videoJobRecord, runtimeDir string) error {
	var rm runtimeManifest
	b, e := os.ReadFile(filepath.Join(runtimeDir, "runtime.json"))
	if e != nil || json.Unmarshal(b, &rm) != nil || rm.Schema != "octop-desktop-video-runtime/1" || rm.TemplateVersion != 1 {
		return videoErr("RUNTIME_MISSING")
	}
	node := "node"
	if runtime.GOOS == "windows" {
		node = "node.exe"
	}
	nodePath := filepath.Join(runtimeDir, node)
	worker := filepath.Join(runtimeDir, "desktop-worker.mjs")
	if st, e := os.Stat(nodePath); e != nil || !st.Mode().IsRegular() {
		return videoErr("RUNTIME_MISSING")
	}
	if st, e := os.Stat(worker); e != nil || !st.Mode().IsRegular() {
		return videoErr("RUNTIME_MISSING")
	}
	outDir := filepath.Join(m.dir(rec.Job.OwnerID), rec.Job.ID, "out")
	if e = os.MkdirAll(outDir, 0700); e != nil {
		return e
	}
	output := filepath.Join(outDir, "final.mp4")
	cmd := exec.Command(nodePath, worker, "--project", rec.DataDir, "--out", output)
	cache := m.environmentCache()
	if e = os.MkdirAll(cache, 0700); e != nil {
		return e
	}
	cmd.Dir = cache
	cmd.Env = setProcessEnv(os.Environ(), "OCTOP_DESKTOP_VIDEO_CACHE", cache)
	configureVideoProcess(cmd)
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	stderr, e := cmd.StderrPipe()
	if e != nil {
		return e
	}
	stdin, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	if e = cmd.Start(); e != nil {
		return e
	}
	m.mu.Lock()
	if rec.Job.State == "cancelled" || rec.Job.State == "interrupted" {
		m.mu.Unlock()
		killVideoProcessTree(cmd)
		_ = cmd.Wait()
		return videoErr("CANCELLED")
	}
	m.cmd = cmd
	m.cmdJob = rec.Job.ID
	m.stdin = stdin
	m.mu.Unlock()
	m.update(rec, "rendering", "", nil)
	go io.Copy(io.Discard, stderr)
	scanner := bufioNewScanner(stdout)
	workerError := ""
	for scanner.Scan() {
		var ev struct {
			Type     string  `json:"type"`
			Stage    string  `json:"stage"`
			Progress float64 `json:"progress"`
			Output   string  `json:"output"`
			Code     string  `json:"code"`
		}
		if json.Unmarshal(scanner.Bytes(), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "stage":
			if ev.Stage == "preparing" || ev.Stage == "rendering" || ev.Stage == "saving" {
				m.update(rec, ev.Stage, "", nil)
			}
		case "progress":
			if ev.Progress >= 0 && ev.Progress <= 1 {
				p := ev.Progress
				m.update(rec, "rendering", "", &p)
			}
		case "error":
			workerError = videoErrorCode(videoErr(ev.Code))
			if workerError == "CANCELLED" {
				m.update(rec, "cancelled", "CANCELLED", nil)
			}
		}
	}
	e = cmd.Wait()
	m.mu.Lock()
	if m.cmdJob == rec.Job.ID {
		m.cmd = nil
		m.stdin = nil
		m.cmdJob = ""
	}
	cancelled := rec.Job.State == "cancelled" || rec.Job.State == "interrupted"
	m.mu.Unlock()
	if e != nil {
		if !cancelled {
			return videoErr("RENDER_FAILED")
		}
		return videoErr("CANCELLED")
	}
	if workerError != "" {
		return videoErr(workerError)
	}
	if cancelled {
		return videoErr("CANCELLED")
	}
	st, e := os.Stat(output)
	if e != nil || !st.Mode().IsRegular() || st.Size() == 0 {
		return videoErr("RENDER_FAILED")
	}
	cap, _ := randomToken()
	rec.Output = output
	rec.Capability = cap
	m.ensureStream()
	m.update(rec, "completed", "", nil)
	return nil
}

// Isolated scanner constructor keeps worker output bounded and line-oriented.
type videoLineScanner interface {
	Scan() bool
	Bytes() []byte
}

func bufioNewScanner(r io.Reader) videoLineScanner { return bufio.NewScanner(r) }

func (m *videoManager) ensureStream() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.server != nil {
		return
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		return
	}
	m.listener = l
	mux := http.NewServeMux()
	mux.HandleFunc("/video/", m.serveVideo)
	m.server = &http.Server{Handler: mux}
	go func() { _ = m.server.Serve(l) }()
}
func (m *videoManager) serveVideo(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 3 || r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	m.mu.Lock()
	rec := m.jobs[parts[1]]
	if rec == nil || rec.Job.State != "completed" || rec.Capability != parts[2] {
		m.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	path := rec.Output
	m.mu.Unlock()
	f, e := os.Open(path)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	http.ServeContent(w, r, "video.mp4", st.ModTime(), f)
}
func (m *videoManager) cancel(token, id string) (VideoJob, error) {
	owner, e := m.owner(context.Background(), token)
	if e != nil {
		return VideoJob{}, e
	}
	m.mu.Lock()
	rec := m.jobs[id]
	if rec == nil || rec.Job.OwnerID != owner {
		m.mu.Unlock()
		return VideoJob{}, videoErr("NOT_FOUND")
	}
	if rec.Job.State == "completed" || rec.Job.State == "failed" || rec.Job.State == "cancelled" {
		j := m.snapshot(rec)
		m.mu.Unlock()
		return j, nil
	}
	cmd, stdin := m.cmd, m.stdin
	cancel := m.cancelRender
	rec.Job.State = "cancelled"
	rec.Job.ErrorCode = "CANCELLED"
	rec.Job.Progress = nil
	rec.Job.UpdatedAt = time.Now().Unix()
	m.persistLocked(rec)
	if m.active == id {
		m.active = ""
	}
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if stdin != nil {
		_, _ = io.WriteString(stdin, "cancel\n")
	}
	if cmd != nil && cmd.Process != nil {
		killVideoProcessTree(cmd)
	}
	return rec.Job, nil
}
func (m *videoManager) retry(token, id string) (VideoJob, error) {
	owner, e := m.owner(context.Background(), token)
	if e != nil {
		return VideoJob{}, e
	}
	status := m.environmentSnapshot()
	if status.State != "ready" {
		if status.State == "checking" || status.State == "verifying" {
			return VideoJob{}, videoErr("BUSY")
		}
		if status.State == "failed" && status.ErrorCode != "" {
			return VideoJob{}, videoErr(status.ErrorCode)
		}
		return VideoJob{}, videoErr("RUNTIME_MISSING")
	}
	m.mu.Lock()
	rec := m.jobs[id]
	if rec == nil || rec.Job.OwnerID != owner {
		m.mu.Unlock()
		return VideoJob{}, videoErr("NOT_FOUND")
	}
	if m.active != "" {
		m.mu.Unlock()
		return VideoJob{}, videoErr("BUSY")
	}
	if m.jobs[id].Job.State == "completed" { // Completed files are already reusable.
		j := m.snapshot(rec)
		m.mu.Unlock()
		return j, nil
	}
	if rec.Job.State != "failed" && rec.Job.State != "cancelled" && rec.Job.State != "interrupted" {
		j := m.snapshot(rec)
		m.mu.Unlock()
		return j, nil
	}
	rec.Job.State = "preparing"
	rec.Job.ErrorCode = ""
	rec.Job.Progress = nil
	rec.Job.UpdatedAt = time.Now().Unix()
	m.persistLocked(rec)
	m.active = id
	m.mu.Unlock()
	job := rec.Job
	go m.retryRun(rec, token)
	return job, nil
}
func (m *videoManager) retryRun(rec *videoJobRecord, token string) {
	// Retry re-fetches the confirmed package, so changed plans are validated by
	// the server and the resulting script gets a fresh data snapshot.
	jobDir := filepath.Join(m.dir(rec.Job.OwnerID), rec.Job.ID)
	_ = os.RemoveAll(filepath.Join(jobDir, "data"))
	_ = os.Remove(filepath.Join(jobDir, "package.zip"))
	_ = os.Remove(filepath.Join(jobDir, "out", "final.mp4"))
	hash, err := m.confirmedScriptHash(token, rec.Job.ProjectID)
	if err != nil {
		m.fail(rec, videoErrorCode(err))
		return
	}
	m.mu.Lock()
	rec.ScriptHash = hash
	m.persistLocked(rec)
	m.mu.Unlock()
	m.run(rec, token)
}

func (a *App) videoAction(action string, payload map[string]json.RawMessage) (any, error) {
	if a.video == nil {
		return nil, videoErr("INTERNAL")
	}
	var token, id, project string
	_ = json.Unmarshal(payload["token"], &token)
	_ = json.Unmarshal(payload["jobId"], &id)
	_ = json.Unmarshal(payload["projectId"], &project)
	if token == "" {
		return nil, videoErr("AUTH_REQUIRED")
	}
	switch action {
	case "environment_check", "environment_verify", "environment_status":
		return a.video.environmentAction(token, action)
	case "start":
		return a.video.start(token, project)
	case "list":
		return a.video.list(token)
	case "get":
		return a.video.get(token, id)
	case "cancel":
		return a.video.cancel(token, id)
	case "retry":
		return a.video.retry(token, id)
	case "save":
		j, e := a.video.get(token, id)
		if e != nil {
			return nil, e
		}
		if j.State != "completed" {
			return nil, videoErr("NOT_FOUND")
		}
		if a.app == nil {
			return nil, videoErr("SAVE_FAILED")
		}
		a.video.mu.Lock()
		r := a.video.jobs[id]
		output, name := "", ""
		if r != nil {
			output, name = r.Output, r.Job.Name
		}
		a.video.mu.Unlock()
		if r == nil {
			return nil, videoErr("NOT_FOUND")
		}
		filename := safeVideoName(name) + ".mp4"
		dest, e := a.app.Dialog.SaveFile().SetFilename(filename).AddFilter("MP4 video", "*.mp4").AttachToWindow(a.window).PromptForSingleSelection()
		if e != nil {
			return nil, videoErr("SAVE_FAILED")
		}
		if dest == "" {
			return map[string]bool{"saved": false}, nil
		}
		if e = copyVideo(output, dest); e != nil {
			return nil, videoErr("SAVE_FAILED")
		}
		return map[string]bool{"saved": true}, nil
	default:
		return nil, videoErr("INTERNAL")
	}
}
func safeVideoName(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(`<>:"/\\|?*`, r) || r < 32 {
			continue
		}
		b.WriteRune(r)
	}
	name := strings.TrimRight(b.String(), ". ")
	if name == "" {
		return "octop-video"
	}
	return name
}
func copyVideo(src, dst string) error {
	srcAbs, srcErr := filepath.Abs(src)
	dstAbs, dstErr := filepath.Abs(dst)
	if srcErr == nil && dstErr == nil && filepath.Clean(srcAbs) == filepath.Clean(dstAbs) {
		return nil
	}
	if srcInfo, err := os.Stat(src); err == nil {
		if dstInfo, err := os.Stat(dst); err == nil && os.SameFile(srcInfo, dstInfo) {
			return nil
		}
	}
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	ce := out.Close()
	if e != nil {
		return e
	}
	return ce
}
