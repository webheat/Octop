package main

import (
	"encoding/json"
	"log"
	"net/url"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The runtime bridge lets the page ask the shell for an optional runtime
// shard (the Tencent Cloud SDK part, for example) without knowing where the
// shell stores it. It mirrors the video bridge: the page emits an event, the
// shell answers with another event.

const runtimeEventPrefix = "desktop:runtime:"

type runtimeBridgeRequest struct {
	ID      string                     `json:"id"`
	Action  string                     `json:"action"`
	Payload map[string]json.RawMessage `json:"payload"`
}
type runtimeBridgeResponse struct {
	ID     string `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type runtimeEventListener struct {
	app   *App
	nonce string
}

func (l *runtimeEventListener) DispatchWailsEvent(e *application.CustomEvent) {
	if e == nil || l.app == nil {
		return
	}
	prefix := runtimeEventPrefix + l.nonce + ":"
	if !strings.HasPrefix(e.Name, prefix) {
		return
	}
	raw, err := url.QueryUnescape(strings.TrimPrefix(e.Name, prefix))
	if err != nil {
		return
	}
	var req runtimeBridgeRequest
	if json.Unmarshal([]byte(raw), &req) != nil || req.ID == "" || len(req.ID) > 128 {
		return
	}
	go func() {
		result, err := l.app.runtimeAction(req.Action, req.Payload)
		response := runtimeBridgeResponse{ID: req.ID, Result: result}
		if err != nil {
			response.Result = nil
			response.Error = runtimeErrorCode(err)
		}
		b, err := json.Marshal(response)
		if err != nil {
			return
		}
		if l.app.window != nil {
			l.app.window.ExecJS(runtimeResponseJS(b))
		}
	}()
}

func runtimeErrorCode(err error) string {
	code := err.Error()
	switch code {
	case runtimeErrUnavailable, runtimeErrNotFound, runtimeErrFailed:
		return code
	}
	log.Printf("desktop runtime error: %v", err)
	return runtimeErrFailed
}

func attachRuntimeEventListener(app *application.App, api *App, nonce string) {
	if app == nil || api == nil || nonce == "" {
		return
	}
	appendWailsEventListener(app, &runtimeEventListener{app: api, nonce: nonce})
}

// runtimeBridgeJS injects the page-side bridge. It only runs on the dashboard
// origin, so a page that navigated somewhere else cannot drive the shell.
func runtimeBridgeJS(base, nonce string) string {
	u, _ := url.Parse(base)
	if u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	origin := u.Scheme + "://" + u.Host
	path := strings.TrimRight(u.EscapedPath(), "/")
	if path == "" {
		path = "/"
	}
	return `(function(){try{if(window.location.origin!==` + jsonString(origin) + `||!(window.location.pathname===` + jsonString(path) + `||window.location.pathname.indexOf(` + jsonString(strings.TrimRight(path, "/")+"/") + `)===0))return;if(!window._wails||typeof window._wails.invoke!=="function")return;if(window.__octopDesktopRuntimeInstalled)return;window.__octopDesktopRuntimeInstalled=true;var nonce=` + jsonString(nonce) + `,seq=0,pending=new Map();window.addEventListener("octop:desktop-runtime-response",function(e){var d=e.detail||{},p=pending.get(d.id);if(!p)return;pending.delete(d.id);d.error?p.reject(Object.assign(new Error(d.error),{code:d.error})):p.resolve(d.result)});window.octopDesktopRuntime={version:1,request:function(action,payload){return new Promise(function(resolve,reject){var id=String(++seq)+"-"+Math.random().toString(36).slice(2);pending.set(id,{resolve:resolve,reject:reject});var body=JSON.stringify({id:id,action:action,payload:payload||{}});window._wails.invoke("wails:event:emit:desktop:runtime:"+nonce+":"+encodeURIComponent(body))})}}}catch(e){}})();`
}

func runtimeResponseJS(b []byte) string {
	return `window.dispatchEvent(new CustomEvent("octop:desktop-runtime-response",{detail:` + string(b) + `}))`
}
