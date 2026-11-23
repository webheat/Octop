package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Local-first library bridge. Mirrors video_bridge.go's origin+nonce double
// check so only the configured dashboard page can drive native file access.

const libraryEventPrefix = "desktop:library:"

type libraryBridgeRequest struct {
	ID      string                     `json:"id"`
	Action  string                     `json:"action"`
	Token   string                     `json:"token"`
	Payload map[string]json.RawMessage `json:"payload"`
}
type libraryBridgeResponse struct {
	ID     string `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type libraryEventListener struct {
	app   *App
	nonce string
}

func (l *libraryEventListener) DispatchWailsEvent(e *application.CustomEvent) {
	if e == nil || l.app == nil {
		return
	}
	prefix := libraryEventPrefix + l.nonce + ":"
	if !strings.HasPrefix(e.Name, prefix) {
		return
	}
	raw, err := url.QueryUnescape(strings.TrimPrefix(e.Name, prefix))
	if err != nil {
		return
	}
	var req libraryBridgeRequest
	if json.Unmarshal([]byte(raw), &req) != nil || req.ID == "" || len(req.ID) > 128 {
		return
	}
	go func() {
		result, err := l.app.libraryAction(req.Action, req.Token, req.Payload)
		resp := libraryBridgeResponse{ID: req.ID, Result: result}
		if err != nil {
			resp.Result = nil
			resp.Error = libraryErrorCode(err)
		}
		b, err := json.Marshal(resp)
		if err != nil {
			return
		}
		if l.app.window != nil {
			l.app.window.ExecJS(libraryResponseJS(b))
		}
	}()
}

func libraryErrorCode(err error) string {
	code := err.Error()
	switch code {
	case "AUTH_REQUIRED", "LIBRARY_NOT_FOUND", "LIBRARY_INVALID", "LIBRARY_IO", "INTERNAL", "CANCELLED", "RUNTIME_MISSING":
		return code
	}
	log.Printf("desktop library error: %v", err)
	return "INTERNAL"
}

func attachLibraryEventListener(app *application.App, api *App, nonce string) {
	if app == nil || api == nil || nonce == "" {
		return
	}
	appendWailsEventListener(app, &libraryEventListener{app: api, nonce: nonce})
}

// libraryStoreFor resolves the owner-scoped local store. It requires the JWT
// to identify the owner (via the backend) so different accounts never share a
// local library — matching the hosted behaviour.
func (a *App) libraryStoreFor(token string) (*localLibraryStore, error) {
	if a.video == nil || token == "" {
		return nil, errors.New("AUTH_REQUIRED")
	}
	owner, err := a.video.owner(contextBackground(), token)
	if err != nil {
		return nil, err
	}
	return newLocalLibraryStore(a.video.base, owner, octopHome())
}

// libraryAction is the closed set of actions the dashboard may call.
func (a *App) libraryAction(action, token string, payload map[string]json.RawMessage) (any, error) {
	store, err := a.libraryStoreFor(token)
	if err != nil {
		return nil, err
	}
	switch action {
	case "list":
		return store.List()

	case "pickFiles":
		paths, err := a.app.Dialog.OpenFile().
			CanChooseFiles(true).
			CanChooseDirectories(false).
			AllowsOtherFileTypes(true).
			AttachToWindow(a.window).
			PromptForMultipleSelection()
		if err != nil {
			return nil, errors.New("CANCELLED")
		}
		return libraryPathsPayload(paths), nil

	case "pickDirectory":
		chosen, err := a.app.Dialog.OpenFile().
			CanChooseFiles(false).
			CanChooseDirectories(true).
			AttachToWindow(a.window).
			PromptForSingleSelection()
		if err != nil || chosen == "" {
			return nil, errors.New("CANCELLED")
		}
		paths, err := collectImagePaths(chosen)
		if err != nil {
			return nil, errLibraryIO
		}
		return libraryPathsPayload(paths), nil

	case "ingest":
		return a.libraryIngest(store, token, payload)

	case "recognizeExisting":
		return a.libraryRecognizeExisting(store, token, payload)

	case "updateMeta":
		var body struct {
			ID   string         `json:"id"`
			Meta map[string]any `json:"meta"`
		}
		if json.Unmarshal(payload["body"], &body) != nil || body.ID == "" {
			return nil, errLibraryInvalid
		}
		return store.UpdateMeta(body.ID, body.Meta)

	case "archiveGroups":
		var body struct {
			Groups []localArchiveGroup `json:"groups"`
		}
		if json.Unmarshal(payload["body"], &body) != nil || len(body.Groups) == 0 {
			return nil, errLibraryInvalid
		}
		return store.ArchiveGroups(body.Groups)

	case "listProducts":
		return store.ListProducts()

	case "productAssets":
		pid := stringPayload(payload, "id")
		if pid == "" {
			return nil, errLibraryInvalid
		}
		return store.ProductAssets(pid)

	case "remove":
		id := stringPayload(payload, "id")
		if id == "" {
			return nil, errLibraryInvalid
		}
		return map[string]any{"ok": store.Remove(id) == nil}, nil

	case "read":
		id := stringPayload(payload, "id")
		data, asset, err := store.Read(id)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"id": id, "mediaType": asset.MediaType,
			"data": base64.StdEncoding.EncodeToString(data),
		}, nil

	case "renderLocal":
		return a.libraryRenderLocal(store, payload)

	case "jobStatus":
		id := stringPayload(payload, "id")
		if id == "" || a.video == nil {
			return nil, errLibraryInvalid
		}
		a.video.mu.Lock()
		rec := a.video.jobs[id]
		var snap any
		if rec != nil {
			// snapshot() fills VideoURL from the local stream when rendering
			// completed, so the local library can preview/download the result
			// without any server round-trip.
			job := a.video.snapshot(rec)
			snap = map[string]any{
				"id": job.ID, "state": job.State,
				"progress": job.Progress, "errorCode": job.ErrorCode,
				"videoUrl": job.VideoURL,
			}
		}
		a.video.mu.Unlock()
		if rec == nil {
			return nil, errLibraryNotFound
		}
		return snap, nil

	default:
		return nil, errLibraryInvalid
	}
}

// libraryIngest reads the chosen local paths, optionally spends one vision
// call per image via the backend's stateless /recognize endpoint, and writes
// the bytes + classification to the local store.
func (a *App) libraryIngest(store *localLibraryStore, token string, payload map[string]json.RawMessage) (any, error) {
	var body struct {
		Paths      []string `json:"paths"`
		Recognize  bool     `json:"recognize"`
		Mode       string   `json:"mode"`
		FolderHint string   `json:"folderHint"`
	}
	if json.Unmarshal(payload["body"], &body) != nil || len(body.Paths) == 0 {
		return nil, errLibraryInvalid
	}
	if len(body.Paths) > 500 {
		return nil, errLibraryInvalid
	}
	results := make([]map[string]any, 0, len(body.Paths))
	for _, path := range body.Paths {
		cleaned := filepath.Clean(path)
		if !filepath.IsAbs(cleaned) || strings.ContainsRune(cleaned, 0) {
			continue
		}
		info, statErr := os.Stat(cleaned)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() > 64<<20 {
			continue
		}
		data, readErr := os.ReadFile(cleaned)
		if readErr != nil {
			continue
		}
		mediaType := mimeTypeFor(cleaned)
		meta := map[string]any{}
		recognitionError := ""
		if body.Recognize && strings.HasPrefix(mediaType, "image/") {
			var err error
			meta, err = a.recognizeBytes(token, data, mediaType, filepath.Base(filepath.Dir(cleaned)), body.Mode)
			if err != nil {
				recognitionError = err.Error()
			}
			if meta == nil {
				meta = map[string]any{}
			}
			meta["recognitionError"] = recognitionError
		}
		asset, addErr := store.Add(filepath.Base(cleaned), mediaType, data, meta)
		if addErr != nil {
			continue
		}
		results = append(results, map[string]any{
			"id": asset.ID, "filename": asset.Filename, "mediaType": asset.MediaType,
			"bytes": asset.Bytes, "sha256": asset.SHA256,
			"group": asset.Group, "category": asset.Category,
			"description": asset.Description, "tags": asset.Tags,
			"localPath": cleaned, "recognitionError": recognitionError,
		})
	}
	return map[string]any{"items": results}, nil
}

// libraryRecognizeExisting retries recognition using the stored local bytes.
func (a *App) libraryRecognizeExisting(store *localLibraryStore, token string, payload map[string]json.RawMessage) (any, error) {
	var body struct {
		IDs  []string `json:"ids"`
		Mode string   `json:"mode"`
	}
	if json.Unmarshal(payload["body"], &body) != nil || len(body.IDs) == 0 || len(body.IDs) > 500 {
		return nil, errLibraryInvalid
	}
	results := make([]map[string]any, 0, len(body.IDs))
	for _, id := range body.IDs {
		item := map[string]any{"id": id}
		data, asset, err := store.Read(id)
		if err == nil {
			var meta map[string]any
			meta, err = a.recognizeBytes(token, data, asset.MediaType, "", body.Mode)
			if err == nil {
				meta["recognitionError"] = ""
				if body.Mode == "describe" {
					delete(meta, "group")
					delete(meta, "category")
				}
				asset, err = store.UpdateMeta(id, meta)
			}
		}
		if err != nil {
			code := err.Error()
			if _, saveErr := store.UpdateMeta(id, map[string]any{"recognitionError": code}); saveErr != nil {
				code = saveErr.Error()
			}
			item["recognitionError"] = code
		} else {
			item["group"] = asset.Group
			item["category"] = asset.Category
			item["description"] = asset.Description
			item["tags"] = asset.Tags
		}
		results = append(results, item)
	}
	return map[string]any{"items": results}, nil
}

// recognizeBytes posts one image to the stateless backend recognize endpoint.
func (a *App) recognizeBytes(token string, data []byte, mediaType, folderHint, mode string) (map[string]any, error) {
	if a.video == nil {
		return nil, errors.New("RECOGNITION_FAILED")
	}
	if mode != "categorize" && mode != "describe" {
		mode = "categorize"
	}
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="files"; filename="image"`)
	header.Set("Content-Type", mediaType)
	part, err := w.CreatePart(header)
	if err != nil {
		return nil, errors.New("RECOGNITION_FAILED")
	}
	_, _ = part.Write(data)
	_ = w.WriteField("mode", mode)
	_ = w.WriteField("paths", folderHint+"/image")
	_ = w.Close()
	ctx, cancel := contextWithTimeoutSeconds(60)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.video.apiURL("/product-library/recognize"), &buf)
	if err != nil {
		return nil, errors.New("RECOGNITION_FAILED")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := a.video.client.Do(req)
	if err != nil {
		return nil, errors.New("RECOGNITION_FAILED")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("RECOGNITION_FAILED")
	}
	var out struct {
		Items []map[string]any `json:"items"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out) != nil || len(out.Items) == 0 {
		return nil, errors.New("RECOGNITION_FAILED")
	}
	if message, ok := out.Items[0]["error"].(string); ok && message != "" {
		switch {
		case strings.Contains(message, "no enabled vision model") || strings.Contains(message, "no vision model configured"):
			return nil, errors.New("VISION_MODEL_UNAVAILABLE")
		case strings.Contains(message, "image exceeds the vision size limit"):
			return nil, errors.New("IMAGE_TOO_LARGE")
		case strings.HasPrefix(message, "unsupported image type:"):
			return nil, errors.New("IMAGE_UNSUPPORTED")
		default:
			return nil, errors.New("RECOGNITION_FAILED")
		}
	}
	return out.Items[0], nil
}

func stringPayload(payload map[string]json.RawMessage, key string) string {
	raw, ok := payload[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func libraryPathsPayload(paths []string) map[string]any {
	items := make([]map[string]any, 0, len(paths))
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		items = append(items, map[string]any{
			"path": p, "name": filepath.Base(p), "bytes": info.Size(),
			"mediaType": mimeTypeFor(p),
		})
	}
	return map[string]any{"items": items}
}

func mimeTypeFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	default:
		return "application/octet-stream"
	}
}

func collectImagePaths(root string) ([]string, error) {
	var out []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.Mode().IsRegular() && strings.HasPrefix(mimeTypeFor(path), "image/") {
			out = append(out, path)
		}
		if len(out) > 500 {
			return filepath.SkipAll
		}
		return nil
	})
	return out, err
}

// JS injection, mirroring videoBridgeJS's origin+nonce guard.
func (a *App) installLibraryBridge() {
	if a.window == nil || a.libraryNonce == "" || a.video == nil {
		return
	}
	a.window.ExecJS(libraryBridgeJS(a.video.base, a.libraryNonce))
}

func libraryBridgeJS(base, nonce string) string {
	u, _ := url.Parse(base)
	if u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	origin := u.Scheme + "://" + u.Host
	path := strings.TrimRight(u.EscapedPath(), "/")
	if path == "" {
		path = "/"
	}
	prefixCheck := strings.TrimRight(path, "/") + "/"
	return `(function(){try{if(window.location.origin!==` + jsonString(origin) + `||!(window.location.pathname===` + jsonString(path) + `||window.location.pathname.indexOf(` + jsonString(prefixCheck) + `)===0))return;if(!window._wails||typeof window._wails.invoke!=="function")return;if(window.__octopDesktopLibraryInstalled)return;window.__octopDesktopLibraryInstalled=true;var nonce=` + jsonString(nonce) + `,seq=0,pending=new Map();window.addEventListener("octop:desktop-library-response",function(e){var d=e.detail||{},p=pending.get(d.id);if(!p)return;pending.delete(d.id);d.error?p.reject(Object.assign(new Error(d.error),{code:d.error})):p.resolve(d.result)});window.octopDesktopLibrary={version:1,request:function(action,token,payload){return new Promise(function(resolve,reject){if(!token){reject(new Error("AUTH_REQUIRED"));return}var id=String(++seq)+"-"+Math.random().toString(36).slice(2);pending.set(id,{resolve:resolve,reject:reject});var body=JSON.stringify({id:id,action:action,token:token,payload:payload||{}});window._wails.invoke("wails:event:emit:desktop:library:"+nonce+":"+encodeURIComponent(body))})}}}catch(e){}})();`
}

func libraryResponseJS(b []byte) string {
	return `window.dispatchEvent(new CustomEvent("octop:desktop-library-response",{detail:` + string(b) + `}))`
}

// Helpers that avoid importing context/time directly in multiple files.
func contextBackground() context.Context { return context.Background() }
func contextWithTimeoutSeconds(seconds int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
}
