package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type VideoEnvironmentStatus struct {
	State           string   `json:"state"`
	Stage           *string  `json:"stage"`
	Progress        *float64 `json:"progress"`
	ErrorCode       string   `json:"errorCode,omitempty"`
	CheckedAt       int64    `json:"checkedAt,omitempty"`
	RequiresInstall bool     `json:"requiresInstall,omitempty"`
}

type environmentMessage struct {
	Type            string   `json:"type"`
	State           string   `json:"state"`
	Stage           *string  `json:"stage"`
	Progress        *float64 `json:"progress"`
	ErrorCode       string   `json:"errorCode"`
	CheckedAt       int64    `json:"checkedAt"`
	RequiresInstall bool     `json:"requiresInstall"`
}

func environmentStage(stage string) *string { return &stage }

func environmentErrorCode(code string) string {
	switch code {
	case "RUNTIME_MISSING", "BROWSER_MISSING", "ENV_DISK_FULL", "ENV_BROWSER_FAILED", "ENV_RENDER_FAILED", "ENV_CHECK_FAILED", "DOWNLOAD_FAILED", "PACKAGE_INVALID", "NO_INSTALLER", "AUTH_REQUIRED", "BUSY", "INTERNAL":
		return code
	default:
		return "ENV_CHECK_FAILED"
	}
}

func sanitizeEnvironmentInstallerURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return ""
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	return u.String()
}

func (m *videoManager) environmentCache() string {
	return filepath.Join(octopHome(), "desktop-video-environment")
}

func (m *videoManager) environmentAction(token, action string) (VideoEnvironmentStatus, error) {
	if _, err := m.owner(context.Background(), token); err != nil {
		return VideoEnvironmentStatus{}, err
	}
	if action == "environment_status" {
		return m.environmentSnapshot(), nil
	}
	if action == "environment_install" {
		return m.startEnvironmentInstall(token)
	}
	if action != "environment_check" && action != "environment_verify" {
		return VideoEnvironmentStatus{}, videoErr("INTERNAL")
	}
	return m.startEnvironment(strings.TrimPrefix(action, "environment_"))
}

func (m *videoManager) environmentSnapshot() VideoEnvironmentStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.environment
}

func (m *videoManager) startEnvironment(mode string) (VideoEnvironmentStatus, error) {
	m.mu.Lock()
	if m.environmentRunning {
		status := m.environment
		m.mu.Unlock()
		return status, nil
	}
	if mode == "verify" && m.active != "" {
		m.mu.Unlock()
		return VideoEnvironmentStatus{}, videoErr("BUSY")
	}
	if mode != "check" && mode != "verify" {
		m.mu.Unlock()
		return VideoEnvironmentStatus{}, videoErr("INTERNAL")
	}
	runtimeDir, err := videoRuntimeDir()
	if err != nil {
		status := VideoEnvironmentStatus{State: "needs_setup", ErrorCode: "RUNTIME_MISSING", CheckedAt: time.Now().Unix(), RequiresInstall: true}
		m.environment = status
		m.mu.Unlock()
		logVideoEnvironment(status)
		return status, nil
	}
	if !videoRuntimeReady(runtimeDir) {
		status := VideoEnvironmentStatus{State: "needs_setup", ErrorCode: "RUNTIME_MISSING", CheckedAt: time.Now().Unix(), RequiresInstall: true}
		m.environment = status
		m.mu.Unlock()
		logVideoEnvironment(status)
		return status, nil
	}
	cache := m.environmentCache()
	if err = os.MkdirAll(cache, 0700); err != nil {
		status := VideoEnvironmentStatus{State: "failed", ErrorCode: "ENV_DISK_FULL", CheckedAt: time.Now().Unix()}
		m.environment = status
		m.mu.Unlock()
		logVideoEnvironment(status)
		return status, nil
	}
	state := "checking"
	if mode == "verify" {
		state = "verifying"
	}
	status := VideoEnvironmentStatus{State: state, Stage: environmentStage("components")}
	m.environment = status
	m.environmentRunning = true
	m.environmentMode = mode
	m.environmentLogKey = environmentLogKey(status)
	m.mu.Unlock()
	logVideoEnvironment(status)
	go m.runEnvironment(mode, runtimeDir, cache)
	return status, nil
}

func videoRuntimeReady(runtimeDir string) bool {
	var manifest runtimeManifest
	data, err := os.ReadFile(filepath.Join(runtimeDir, "runtime.json"))
	if err != nil || json.Unmarshal(data, &manifest) != nil || manifest.Schema != "octop-desktop-video-runtime/1" || manifest.TemplateVersion != 1 {
		return false
	}
	node := "node"
	if runtime.GOOS == "windows" {
		node = "node.exe"
	}
	for _, name := range []string{node, "desktop-worker.mjs"} {
		st, err := os.Stat(filepath.Join(runtimeDir, name))
		if err != nil || !st.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func (m *videoManager) runEnvironment(mode, runtimeDir, cache string) {
	node := "node"
	if runtime.GOOS == "windows" {
		node = "node.exe"
	}
	worker := filepath.Join(runtimeDir, "desktop-worker.mjs")
	cmd := exec.Command(filepath.Join(runtimeDir, node), worker, "--"+mode, "--cache", cache)
	cmd.Dir = cache
	cmd.Env = setProcessEnv(os.Environ(), "OCTOP_DESKTOP_VIDEO_CACHE", cache)
	configureVideoProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.finishEnvironment(mode, "ENV_CHECK_FAILED")
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.finishEnvironment(mode, "ENV_CHECK_FAILED")
		return
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		m.finishEnvironment(mode, "ENV_CHECK_FAILED")
		return
	}
	if err = cmd.Start(); err != nil {
		m.finishEnvironment(mode, "ENV_CHECK_FAILED")
		return
	}
	m.mu.Lock()
	if !m.environmentRunning || m.environmentMode != mode {
		m.mu.Unlock()
		killVideoProcessTree(cmd)
		_ = cmd.Wait()
		return
	}
	m.environmentCmd = cmd
	m.environmentStdin = stdin
	m.mu.Unlock()
	go io.Copy(io.Discard, stderr)
	timeout := 90 * time.Second
	if mode == "verify" {
		timeout = 20 * time.Minute
	}
	timer := time.AfterFunc(timeout, func() { killVideoProcessTree(cmd) })
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	var final *VideoEnvironmentStatus
	for scanner.Scan() {
		var msg environmentMessage
		if json.Unmarshal(scanner.Bytes(), &msg) != nil || msg.Type != "environment" {
			continue
		}
		status, ok := sanitizeEnvironmentMessage(msg)
		if !ok {
			continue
		}
		switch status.State {
		case "ready", "needs_setup", "failed":
			final = &status
		default:
			m.setEnvironmentStatus(status)
		}
	}
	waitErr := cmd.Wait()
	timer.Stop()
	m.mu.Lock()
	if m.environmentCmd == cmd {
		m.environmentCmd = nil
		m.environmentStdin = nil
	}
	m.mu.Unlock()
	if final != nil && final.State == "needs_setup" {
		final.CheckedAt = time.Now().Unix()
		m.setEnvironmentStatus(*final)
		m.mu.Lock()
		m.environmentRunning = false
		m.environmentMode = ""
		m.mu.Unlock()
		return
	}
	if waitErr != nil || final == nil {
		code := "ENV_CHECK_FAILED"
		if final != nil && final.ErrorCode != "" {
			code = final.ErrorCode
		}
		m.finishEnvironment(mode, code)
		return
	}
	if final.State == "failed" && final.ErrorCode == "" {
		final.ErrorCode = "ENV_CHECK_FAILED"
	}
	final.CheckedAt = time.Now().Unix()
	m.setEnvironmentStatus(*final)
	m.mu.Lock()
	m.environmentRunning = false
	m.environmentMode = ""
	m.mu.Unlock()
}

func sanitizeEnvironmentMessage(msg environmentMessage) (VideoEnvironmentStatus, bool) {
	status := VideoEnvironmentStatus{State: msg.State, Stage: msg.Stage, Progress: msg.Progress, RequiresInstall: msg.RequiresInstall}
	switch status.State {
	case "unknown", "checking", "installing", "needs_setup", "verifying", "ready", "failed":
	default:
		return VideoEnvironmentStatus{}, false
	}
	if status.Stage != nil {
		switch *status.Stage {
		case "components", "browser", "render_test":
		default:
			return VideoEnvironmentStatus{}, false
		}
	}
	if status.Progress != nil && (*status.Progress < 0 || *status.Progress > 1) {
		return VideoEnvironmentStatus{}, false
	}
	if msg.ErrorCode != "" {
		status.ErrorCode = environmentErrorCode(msg.ErrorCode)
	}
	if msg.CheckedAt > 0 {
		status.CheckedAt = msg.CheckedAt
	}
	return status, true
}

func (m *videoManager) setEnvironmentStatus(status VideoEnvironmentStatus) {
	m.mu.Lock()
	m.environment = status
	key := environmentLogKey(status)
	changed := key != m.environmentLogKey
	m.environmentLogKey = key
	m.mu.Unlock()
	if changed {
		logVideoEnvironment(status)
	}
}

func environmentLogKey(status VideoEnvironmentStatus) string {
	stage := "none"
	if status.Stage != nil {
		stage = *status.Stage
	}
	return status.State + ":" + stage + ":" + status.ErrorCode
}

func (m *videoManager) finishEnvironment(mode, code string) {
	m.mu.Lock()
	if m.environmentRunning && m.environmentMode == mode {
		m.environment = VideoEnvironmentStatus{State: "failed", ErrorCode: environmentErrorCode(code), CheckedAt: time.Now().Unix()}
		m.environmentRunning = false
		m.environmentMode = ""
		m.environmentCmd = nil
		m.environmentStdin = nil
	}
	status := m.environment
	m.mu.Unlock()
	logVideoEnvironment(status)
}

func (m *videoManager) shutdownEnvironment() {
	m.mu.Lock()
	cmd, stdin := m.environmentCmd, m.environmentStdin
	m.environmentRunning = false
	m.environmentMode = ""
	m.mu.Unlock()
	if stdin != nil {
		_, _ = io.WriteString(stdin, "cancel\n")
	}
	if cmd != nil {
		killVideoProcessTree(cmd)
	}
}

func setProcessEnv(env []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(strings.ToUpper(item), strings.ToUpper(prefix)) {
			result = append(result, item)
		}
	}
	return append(result, prefix+value)
}

func logVideoEnvironment(status VideoEnvironmentStatus) {
	stage, code := "none", status.ErrorCode
	if status.Stage != nil {
		stage = *status.Stage
	}
	navLogf("video environment state=%s stage=%s code=%s", status.State, stage, code)
}
