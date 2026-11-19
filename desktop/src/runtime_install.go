package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"

	"octop.desktop/bootstrap"
)

// Error codes the shell reports to the page for runtime part failures. They
// match the codes the video bridge uses so the page can treat both the same.
const (
	runtimeErrUnavailable = "RUNTIME_UNAVAILABLE"
	runtimeErrNotFound    = "NOT_FOUND"
	runtimeErrFailed      = "DOWNLOAD_FAILED"
)

// runtimePartInfo describes one part of the runtime manifest.
type runtimePartInfo struct {
	ID       string `json:"id"`
	Required bool   `json:"required"`
	Size     int64  `json:"size,omitempty"`
}

// installRuntimePart fetches one optional runtime shard and unpacks it next to
// the runtime that is already installed.
//
// The backend asks for a part by id: when a feature is missing its optional
// component it answers FEATURE_DEPS_MISSING with details.part, and the page
// passes that id here. The root part is refused on purpose — it owns the
// runtime directory and is installed at boot, never on demand.
func (a *App) installRuntimePart(partID string) error {
	if partID == "" {
		return errors.New(runtimeErrNotFound)
	}
	manifest, err := loadRuntimeManifest()
	if err != nil {
		navLogf("runtime: manifest unavailable: %v", err)
		return errors.New(runtimeErrUnavailable)
	}
	if manifest == nil {
		return errors.New(runtimeErrUnavailable)
	}
	part, ok := manifestPart(*manifest, partID)
	if !ok {
		return errors.New(runtimeErrNotFound)
	}
	if part.Target == "" {
		// The root part empties the runtime directory. Installing it on demand
		// would throw away the runtime that is running right now.
		return errors.New(runtimeErrFailed)
	}
	opts := bootstrap.Options{
		Root:     portableDir(),
		CacheDir: filepath.Join(octopHome(), "portable-cache"),
		Manifest: *manifest,
		Client:   runtimeHTTPClient,
		Merge:    true,
		Progress: func(progress bootstrap.Progress) {
			if progress.Total > 0 {
				navLogf("runtime part %s: %d%%", partID, progress.Percent())
			}
		},
		Log: navLogf,
	}
	if err := bootstrap.RunParts(opts, []string{partID}); err != nil {
		navLogf("runtime: part %s failed: %v", partID, err)
		return fmt.Errorf("%s", runtimeErrFailed)
	}
	navLogf("runtime: part %s installed", partID)
	return nil
}

// runtimeParts lists the parts the current manifest offers.
func (a *App) runtimeParts() ([]runtimePartInfo, error) {
	manifest, err := loadRuntimeManifest()
	if err != nil {
		return nil, errors.New(runtimeErrUnavailable)
	}
	if manifest == nil {
		return nil, errors.New(runtimeErrUnavailable)
	}
	parts := make([]runtimePartInfo, 0, len(manifest.Parts))
	for _, part := range manifest.Parts {
		parts = append(parts, runtimePartInfo{
			ID:       part.ID,
			Required: part.Required,
			Size:     part.Size,
		})
	}
	return parts, nil
}

// runtimeAction dispatches one bridge action from the page.
func (a *App) runtimeAction(action string, payload map[string]json.RawMessage) (any, error) {
	switch action {
	case "install_part":
		partID := ""
		if raw, ok := payload["part"]; ok {
			_ = json.Unmarshal(raw, &partID)
		}
		if partID == "" {
			return nil, errors.New(runtimeErrNotFound)
		}
		if err := a.installRuntimePart(partID); err != nil {
			return nil, err
		}
		return map[string]any{"part": partID, "installed": true}, nil
	case "parts":
		parts, err := a.runtimeParts()
		if err != nil {
			return nil, err
		}
		return map[string]any{"parts": parts}, nil
	default:
		return nil, errors.New(runtimeErrFailed)
	}
}

// manifestPart finds a part by id.
func manifestPart(manifest bootstrap.Manifest, partID string) (bootstrap.Part, bool) {
	for _, part := range manifest.Parts {
		if part.ID == partID {
			return part, true
		}
	}
	return bootstrap.Part{}, false
}
