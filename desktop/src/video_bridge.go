package main

import (
	"encoding/json"
	"log"
	"net/url"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const videoEventPrefix = "desktop:video:"

type videoBridgeRequest struct {
	ID      string                     `json:"id"`
	Action  string                     `json:"action"`
	Payload map[string]json.RawMessage `json:"payload"`
}
type videoBridgeResponse struct {
	ID     string `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type videoEventListener struct {
	app   *App
	nonce string
}

func (l *videoEventListener) DispatchWailsEvent(e *application.CustomEvent) {
	if e == nil || l.app == nil {
		return
	}
	prefix := videoEventPrefix + l.nonce + ":"
	if !strings.HasPrefix(e.Name, prefix) {
		return
	}
	raw, err := url.QueryUnescape(strings.TrimPrefix(e.Name, prefix))
	if err != nil {
		return
	}
	var req videoBridgeRequest
	if json.Unmarshal([]byte(raw), &req) != nil || req.ID == "" || len(req.ID) > 128 {
		return
	}
	go func() {
		result, err := l.app.videoAction(req.Action, req.Payload)
		response := videoBridgeResponse{ID: req.ID, Result: result}
		if err != nil {
			response.Result = nil
			response.Error = videoErrorCode(err)
		}
		b, err := json.Marshal(response)
		if err != nil {
			return
		}
		if l.app.window != nil {
			l.app.window.ExecJS(videoResponseJS(b))
		}
	}()
}
func videoErrorCode(err error) string {
	code := err.Error()
	switch code {
	case "AUTH_REQUIRED", "NOT_FOUND", "PLAN_NOT_CONFIRMED", "PLAN_CHANGED", "BUSY", "DOWNLOAD_FAILED", "PACKAGE_INVALID", "NO_INSTALLER", "RUNTIME_UNAVAILABLE", "RENDER_FAILED", "SAVE_FAILED", "CANCELLED", "RUNTIME_MISSING", "BROWSER_MISSING", "ENV_DISK_FULL", "ENV_BROWSER_FAILED", "ENV_RENDER_FAILED", "ENV_CHECK_FAILED", "INTERNAL":
		return code
	}
	log.Printf("desktop video error: %v", err)
	return "INTERNAL"
}
func attachVideoEventListener(app *application.App, api *App, nonce string) {
	if app == nil || api == nil || nonce == "" {
		return
	}
	appendWailsEventListener(app, &videoEventListener{app: api, nonce: nonce})
}

func videoBridgeJS(base, nonce string) string {
	u, _ := url.Parse(base)
	if u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	origin := u.Scheme + "://" + u.Host
	path := strings.TrimRight(u.EscapedPath(), "/")
	if path == "" {
		path = "/"
	}
	minimalMode := "false"
	if minimalModeEnabled() {
		minimalMode = "true"
	}
	return `(function(){try{if(window.location.origin!==` + jsonString(origin) + `||!(window.location.pathname===` + jsonString(path) + `||window.location.pathname.indexOf(` + jsonString(strings.TrimRight(path, "/")+"/") + `)===0))return;if(!window._wails||typeof window._wails.invoke!=="function")return;if(window.__octopDesktopVideoInstalled)return;window.__octopDesktopVideoInstalled=true;var nonce=` + jsonString(nonce) + `,seq=0,pending=new Map();window.addEventListener("octop:desktop-video-response",function(e){var d=e.detail||{},p=pending.get(d.id);if(!p)return;pending.delete(d.id);d.error?p.reject(Object.assign(new Error(d.error),{code:d.error})):p.resolve(d.result)});window.octopDesktopVideo={version:1,minimalMode:` + minimalMode + `,environmentVersion:1,environmentInstallerURL:` + jsonString(sanitizeEnvironmentInstallerURL(defaultVideoComponentsURL)) + `,request:function(action,payload){return new Promise(function(resolve,reject){var id=String(++seq)+"-"+Math.random().toString(36).slice(2);pending.set(id,{resolve:resolve,reject:reject});var body=JSON.stringify({id:id,action:action,payload:payload||{}});window._wails.invoke("wails:event:emit:desktop:video:"+nonce+":"+encodeURIComponent(body))})}}}catch(e){}})();`
}
func videoResponseJS(b []byte) string {
	return `window.dispatchEvent(new CustomEvent("octop:desktop-video-response",{detail:` + string(b) + `}))`
}
