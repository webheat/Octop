package main

// desktopFrontendMarkerJS marks the renderer as running inside the Octop
// desktop shell and strips any Service Worker left over from a previous
// session.
//
// Why this exists
// ---------------
// The thin (remote) build loads the Dashboard from the server, so the page
// runs in a plain WebView2 that had no marker telling it "you are the
// desktop client". `dashboard/src/main.tsx` skips Service Worker registration
// when the page knows it is inside the shell, but the thin shell never
// injected that marker — only `window.octopDesktopVideo`. The renderer
// therefore registered the production Service Worker, which cached the remote
// chunks in the WebView2 profile and kept serving a stale frontend after the
// server deployed a new build (symptoms: the old video-environment page and
// missing sidebar entries).
//
// The fix has three parts:
//  1. Set `window.octopDesktopShell` so the renderer never registers the SW.
//  2. Unregister any SW a previous version already registered and drop its
//     caches, so the current page is not served from the stale cache.
//  3. Reload once when a stale worker was found: the document that is on
//     screen was rendered by that worker, so it only becomes correct after
//     the reload.
//
// The script is idempotent and safe to run on every navigation.
func desktopFrontendMarkerJS() string {
	return `(function(){try{
window.octopDesktopShell=true;
if(window.__octopDesktopSwCleaned){return;}
window.__octopDesktopSwCleaned=true;
if(!navigator.serviceWorker){return;}
navigator.serviceWorker.getRegistrations().then(function(regs){
if(!regs||!regs.length){return;}
return Promise.all(regs.map(function(r){return r.unregister();})).then(function(){
if(!window.caches){return null;}
return caches.keys().then(function(keys){
return Promise.all(keys.map(function(k){return caches.delete(k);}));
});
}).then(function(){
try{window.location.reload();}catch(e){}
});
}).catch(function(){});
}catch(e){}})();`
}
