package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// libraryRenderLocal assembles a render project entirely from the local
// material library and starts the local Remotion worker. No storyboard-package
// is downloaded from the server — this is the proof of PRD §3.7's core:
// material bytes come from the client machine.

type localRenderRequest struct {
	ProjectID   string            `json:"projectId"`
	Title       string            `json:"title"`
	Script      json.RawMessage   `json:"script"`
	AssetMap    map[string]string `json:"assetMap"` // export name -> local asset id
	AudioJSON   json.RawMessage   `json:"audioJson"`
}

func (a *App) libraryRenderLocal(store *localLibraryStore, payload map[string]json.RawMessage) (any, error) {
	if a.video == nil {
		return nil, errors.New("INTERNAL")
	}
	var req localRenderRequest
	if json.Unmarshal(payload["body"], &req) != nil || !validProjectID(req.ProjectID) || len(req.Script) == 0 {
		return nil, errLibraryInvalid
	}
	var script videoScript
	if json.Unmarshal(req.Script, &script) != nil || len(script.Scenes) == 0 {
		return nil, errLibraryInvalid
	}
	if len(req.AssetMap) > 200 {
		return nil, errLibraryInvalid
	}

	// Owner is derived from the store's token already validated in libraryAction;
	// reuse the active owner via a fresh resolution to keep job scoping exact.
	// The caller's token is re-read from the request payload is not available here,
	// so we scope jobs under a stable key derived from the store root.
	owner := storeJobOwner(store.root)

	if a.video.environmentSnapshot().State != "ready" {
		return nil, errors.New("RUNTIME_MISSING")
	}

	id, err := randomToken()
	if err != nil {
		return nil, errors.New("INTERNAL")
	}
	jobDir := filepath.Join(a.video.dir(owner), id)
	if err := os.MkdirAll(jobDir, 0700); err != nil {
		return nil, errLibraryIO
	}
	dataDir := filepath.Join(jobDir, "data")
	assetsDir := filepath.Join(dataDir, "assets")
	if err := os.MkdirAll(assetsDir, 0700); err != nil {
		return nil, errLibraryIO
	}

	// Verify every scene asset is mapped and present locally, then copy in.
	needed := map[string]string{}
	for _, scene := range script.Scenes {
		if scene.Asset == "" {
			continue
		}
		localID, ok := req.AssetMap[scene.Asset]
		if !ok || localID == "" {
			return nil, errLibraryNotFound
		}
		needed[scene.Asset] = localID
	}
	if err := store.CopyInto(assetsDir, needed); err != nil {
		return nil, err
	}

	// script.json — byte-for-byte what the client asked us to render.
	if err := os.WriteFile(filepath.Join(dataDir, "script.json"), req.Script, 0600); err != nil {
		return nil, errLibraryIO
	}
	if len(req.AudioJSON) > 0 {
		_ = os.WriteFile(filepath.Join(dataDir, "audio.json"), req.AudioJSON, 0600)
	}

	// manifest.json — mirror package_export.py's shape so project.mjs validates.
	scriptSum := sha256.Sum256(req.Script)
	manifest := videoManifest{
		Schema: "octop-remotion-package/1", TemplateVersion: "1",
		ProjectID: req.ProjectID, ProjectName: req.Title,
		ScriptSHA: hex.EncodeToString(scriptSum[:]),
		Assets:    []struct{ Path string `json:"path"`; SHA string `json:"sha256"`; Bytes int64 `json:"bytes"` }{},
	}
	for exportName, localID := range needed {
		path, asset, aerr := store.AssetPath(localID)
		if aerr != nil {
			return nil, aerr
		}
		info, serr := os.Stat(path)
		if serr != nil {
			return nil, errLibraryIO
		}
		manifest.Assets = append(manifest.Assets, struct {
			Path  string `json:"path"`
			SHA   string `json:"sha256"`
			Bytes int64  `json:"bytes"`
		}{Path: "assets/" + exportName, SHA: asset.SHA256, Bytes: info.Size()})
	}
	mb, err := json.Marshal(manifest)
	if err != nil {
		return nil, errLibraryIO
	}
	if err := os.WriteFile(filepath.Join(dataDir, "manifest.json"), mb, 0600); err != nil {
		return nil, errLibraryIO
	}

	rec := &videoJobRecord{
		Job: VideoJob{
			ID: id, ProjectID: req.ProjectID, OwnerID: owner,
			Name: req.Title, State: "preparing", UpdatedAt: time.Now().Unix(),
		},
		DataDir: dataDir,
	}
	a.video.mu.Lock()
	a.video.jobs[id] = rec
	a.video.mu.Unlock()
	a.video.update(rec, "rendering", "", nil)

	runtimeDir, err := videoRuntimeDir()
	if err != nil {
		a.video.fail(rec, "RUNTIME_MISSING")
		return nil, errors.New("RUNTIME_MISSING")
	}
	go func() {
		_ = synthesizeLocalNarration(dataDir)
		if e := startVideoWorker(a.video, rec, runtimeDir); e != nil {
			if rec.Job.State != "cancelled" && rec.Job.State != "interrupted" {
				a.video.fail(rec, videoErrorCode(e))
			}
		}
	}()
	return map[string]any{"jobId": id, "state": "rendering"}, nil
}

func storeJobOwner(root string) string {
	sum := sha256.Sum256([]byte(root))
	return "local-" + hex.EncodeToString(sum[:8])
}
