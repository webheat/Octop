package main

// desktopFrontendMarkerJS marks the renderer as running inside the Octop
// desktop shell and strips any Service Worker left over from a previous
// session.
//
// Why this exists
// ---------------
// The thin (remote) build loads the Dashboard from the server, so the page
// runs in a plain WebView2 whose profile (`%APPDATA%\<exe name>`) persists
// between runs. If the page ever registers a Service Worker, that worker
// caches the remote chunks in the profile and keeps serving a stale
// frontend long after the server deployed a new build (symptoms: the old
// video-environment page and missing sidebar entries).
//
// The fix has two parts:
//  1. Set `window.octopDesktopShell` so the renderer can recognise itself.
//  2. Unregister any SW a previous version already registered and drop its
//     caches, so the profile stops serving the stale build.
//
// Note there is deliberately no `location.reload()` here. The document on
// screen was rendered by the stale worker, but reloading during start-up
// races the shell's own navigation and can leave the window on a blank
// page. The dashboard itself skips the registration in the first place
// (it sees the `?desktop=1` flag on the URL), so the next navigation picks
// up the fresh assets without any reload.
//
// The script is idempotent and safe to run on every navigation.
func desktopFrontendMarkerJS() string {
	return `(function(){try{
window.octopDesktopShell=true;
try{window.localStorage.setItem("octop.desktopShell","1");}catch(e){}
if(window.__octopDesktopSwCleaned){return;}
window.__octopDesktopSwCleaned=true;
if(!navigator.serviceWorker){return;}
navigator.serviceWorker.getRegistrations().then(function(regs){
if(!regs||!regs.length){return null;}
return Promise.all(regs.map(function(r){return r.unregister();})).then(function(){
if(!window.caches){return null;}
return caches.keys().then(function(keys){
return Promise.all(keys.map(function(k){return caches.delete(k);}));
});
});
}).catch(function(){});
}catch(e){}})();`
}
