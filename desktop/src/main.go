package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed assets/*
var assets embed.FS

const trayDoubleClick = 400 * time.Millisecond

// defaultServerURL is baked in at build time via
// -ldflags "-X main.defaultServerURL=https://host/prefix". Release packages
// point the shell at the hosted Octop instance so end users need neither the
// environment variable nor a bundled local runtime. Empty means local mode.
var defaultServerURL string

// defaultVideoComponentsURL is the URL of the video components manifest,
// baked in via -ldflags "-X main.defaultVideoComponentsURL=https://.../manifest.json".
// The native shell downloads its parts on demand (environment_install); it
// never executes an installer and never touches system PATH. Empty means the
// UI falls back to the "contact administrator" guidance.
var defaultVideoComponentsURL string

// portableRuntimeURL is baked in at build time via
// -ldflags "-X main.portableRuntimeURL=https://host/Octop-portable-<plat>-<version>.zip".
// Slim installers ship no embedded runtime: the first launch downloads it
// from this URL instead.
var portableRuntimeURL string

// portableRuntimeVersion is the runtime version the download URL carries,
// baked in alongside portableRuntimeURL. A newer value refreshes the local
// runtime on the next launch.
var portableRuntimeVersion string

// portableRuntimeManifestURL points at a manifest that describes the runtime
// parts — their URLs, mirrors, sizes and checksums. A slim installer with a
// manifest verifies every part it downloads; without one it falls back to
// portableRuntimeURL and trusts the archive it gets.
var portableRuntimeManifestURL string

// portableRuntimeManifestSHA256 is the expected checksum of the manifest
// body. An empty value means the manifest is trusted as it was fetched.
var portableRuntimeManifestSHA256 string

// resolveRemoteDashboardURL picks the remote dashboard target for boot: the
// OCTOP_DESKTOP_URL environment variable wins over the build-time default
// (baked in via -ldflags "-X main.defaultServerURL=..."); an empty result
// means fall back to the bundled portable runtime (local mode).
func resolveRemoteDashboardURL() string {
	if url := os.Getenv("OCTOP_DESKTOP_URL"); url != "" {
		return url
	}
	return defaultServerURL
}

// App is the Wails service bound to the shell UI.
type App struct {
	app            *application.App
	window         *application.WebviewWindow
	settingsWindow *application.WebviewWindow
	store          *settingsStore
	sleep          *sleepGuard
	cmd            *exec.Cmd
	mu             sync.Mutex
	quitting       bool

	trayClickMu    sync.Mutex
	lastTrayClick  time.Time
	trayClickTimer *time.Timer
	drops          dropServer
	ownsListenPort bool
	webviewReady   bool
	pendingURL     string
	video          *videoManager
	videoNonce     string

	// minimalLandingPath is the product-library path the shell keeps the
	// browser on while minimal mode is enabled ("" when disabled).
	minimalLandingPath string
}

func (a *App) ServiceName() string { return "desktop" }

func (a *App) ServiceStartup(context.Context, application.ServiceOptions) error { return nil }

func (a *App) ServiceShutdown() error {
	a.sleep.stop()
	if a.video != nil {
		a.video.shutdownEnvironment()
		a.video.interrupt()
	}
	a.mu.Lock()
	cmd := a.cmd
	a.cmd = nil
	ownsPort := a.ownsListenPort
	a.ownsListenPort = false
	a.mu.Unlock()
	stopOctop(cmd)
	if ownsPort {
		clearDesktopPort()
	}
	return nil
}

func (a *App) GetSettings() Settings {
	return a.store.get()
}

func (a *App) GetSettingsStatus() (Settings, error) {
	s := a.store.get()
	if a.app == nil {
		return s, nil
	}
	status, err := a.app.Autostart.Status()
	if err != nil {
		return s, fmt.Errorf("read autostart status: %w", err)
	}
	if s.Autostart != status.Enabled {
		s.Autostart = status.Enabled
		if err := a.store.save(s); err != nil {
			return s, err
		}
	}
	return s, nil
}

func (a *App) SaveSettings(next Settings) (Settings, error) {
	cur, err := a.GetSettingsStatus()
	if err != nil {
		return cur, err
	}
	autostart, err := a.setAutostart(next.Autostart)
	if err != nil {
		return cur, err
	}
	if err := a.sleep.set(next.PreventSleep); err != nil {
		if _, rollbackErr := a.setAutostart(cur.Autostart); rollbackErr != nil {
			log.Printf("rollback autostart after sleep prevention failure: %v", rollbackErr)
		}
		return cur, err
	}
	next.Autostart = autostart
	if err := a.store.save(next); err != nil {
		return cur, err
	}
	saved := a.store.get()
	a.applyDashboardPrefs(saved)
	return saved, nil
}

func (a *App) ShowMain() {
	a.showWindow()
}

func (a *App) HideSettings() {
	if a.settingsWindow == nil {
		return
	}
	a.settingsWindow.Hide()
}

func (a *App) Quit() {
	a.requestQuit()
}

func (a *App) setAutostart(on bool) (bool, error) {
	if a.app == nil {
		return false, fmt.Errorf("autostart is unavailable before the application starts")
	}
	if on {
		if err := a.app.Autostart.Enable(); err != nil {
			return false, fmt.Errorf("enable autostart: %w", err)
		}
	} else if err := a.app.Autostart.Disable(); err != nil {
		return false, fmt.Errorf("disable autostart: %w", err)
	}
	status, err := a.app.Autostart.Status()
	if err != nil {
		return false, fmt.Errorf("read autostart status: %w", err)
	}
	if status.Enabled != on {
		return status.Enabled, fmt.Errorf("autostart state did not update")
	}
	return status.Enabled, nil
}

func (a *App) applyDashboardPrefs(s Settings) {
	if a.window == nil {
		return
	}
	js := fmt.Sprintf(
		`(function(){try{localStorage.setItem('octop:ui-locale',%s);}catch(e){}})();`,
		jsonString(string(s.Locale)),
	)
	a.window.ExecJS(js)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func (a *App) setStatus(msg string) {
	if a.app == nil {
		return
	}
	a.app.Event.Emit("desktop:status", msg)
}

func (a *App) boot() {
	locale := LocaleEN
	if a.store != nil {
		locale = a.store.get().Locale
	}
	if url := resolveRemoteDashboardURL(); url != "" {
		navLogf("boot: remote target %s", redactURL(url))
		a.setStatus(desktopText(locale, copyStatusConnecting))
		started := time.Now()
		if err := waitHealth(locale, url, 60*time.Second); err != nil {
			navLogf("boot: health probe failed after %s: %v", time.Since(started).Round(time.Millisecond), err)
			a.setStatus(err.Error())
			return
		}
		navLogf("boot: health probe ok in %s, showing %s", time.Since(started).Round(time.Millisecond), redactURL(url))
		a.showDashboard(url)
		return
	}
	navLogf("boot: no remote target, starting bundled runtime")
	a.setStatus(desktopText(locale, copyStatusCheckingRuntime))
	if err := ensurePortable(locale, a.setStatus); err != nil {
		a.setStatus(err.Error())
		return
	}
	root := portableDir()
	a.mu.Lock()
	stopOctop(a.cmd)
	a.cmd = nil
	a.mu.Unlock()
	host, preferred := resolveListen()
	if existing := findRunningDashboard(host, preferred); existing != "" {
		a.setStatus(desktopText(locale, copyStatusUsingExisting))
		if err := waitHealth(locale, existing, 30*time.Second); err != nil {
			a.setStatus(err.Error())
			return
		}
		a.showDashboard(existing)
		return
	}
	port, err := chooseFreePort(host, preferred)
	if err != nil {
		var busy noFreePortError
		var bind cannotBindError
		switch {
		case errors.As(err, &busy):
			a.setStatus(desktopText(locale, copyErrorNoFreePort, busy.From, busy.To))
		case errors.As(err, &bind):
			a.setStatus(desktopText(locale, copyErrorCannotBind, bind.Host, bind.Port, bind.Err.Error()))
		default:
			a.setStatus(err.Error())
		}
		return
	}
	a.mu.Lock()
	cmd, err := startOctop(root, port)
	a.cmd = cmd
	a.mu.Unlock()
	if err != nil {
		a.setStatus(err.Error())
		return
	}
	base := dashboardURL(host, port)
	a.setStatus(desktopText(locale, copyStatusStartingService))
	if err := waitHealth(locale, base, 2*time.Minute); err != nil {
		a.setStatus(err.Error())
		return
	}
	if err := writeDesktopPort(port); err != nil {
		log.Printf("desktop port: %v", err)
	} else {
		a.mu.Lock()
		a.ownsListenPort = true
		a.mu.Unlock()
	}
	a.showDashboard(base)
}

// navigate points the window at base.
//
// The navigation is deferred until the webview has finished its first load:
// right after start-up the WebView2 controller does not exist yet and SetURL
// on it dereferences a nil pointer, killing the shell.
func (a *App) navigate(base string) {
	a.mu.Lock()
	ready := a.webviewReady
	if !ready {
		a.pendingURL = base
	}
	a.mu.Unlock()
	if !ready {
		navLogf("navigate: deferred %s (webview not ready)", redactURL(base))
		return
	}
	navLogf("navigate: set URL %s", redactURL(base))
	a.window.SetURL(base)
}

// markWebviewReady records that the webview completed its first navigation
// and applies the navigation that was waiting for it.
//
// It is called for every navigation, so it has to stay idempotent: the
// pending URL is cleared once it has been applied.
func (a *App) markWebviewReady() {
	a.mu.Lock()
	a.webviewReady = true
	base := a.pendingURL
	a.pendingURL = ""
	a.mu.Unlock()
	if base != "" && a.window != nil {
		a.window.SetURL(base)
	}
}

func (a *App) showDashboard(base string) {
	if a.window == nil {
		return
	}
	landing := minimalDashboardURL(base)
	if landing != base {
		a.mu.Lock()
		a.minimalLandingPath = landingPath(landing)
		a.mu.Unlock()
	}
	// Tag the URL so the dashboard can tell it is inside the desktop shell
	// before its first script runs, and therefore never register a Service
	// Worker that would pin this profile to a stale build.
	landing = withDesktopURLFlag(landing)
	a.navigate(landing)
	if a.video == nil {
		a.video = newVideoManager(base)
	}
	a.scheduleDragOverlay()
	s := a.store.get()
	go func() {
		time.Sleep(800 * time.Millisecond)
		a.applyDashboardPrefs(s)
	}()
	a.setStatus(desktopText(s.Locale, copyStatusReady))
}

func (a *App) hideToTray() {
	if a.window == nil {
		return
	}
	a.window.Hide()
}

func (a *App) showWindow() {
	if a.window == nil {
		return
	}
	if a.window.IsMinimised() {
		a.window.UnMinimise()
	}
	a.window.Show()
	a.window.Focus()
}

func (a *App) toggleMainWindow() {
	if a.window == nil {
		return
	}
	if a.window.IsVisible() && !a.window.IsMinimised() {
		a.hideToTray()
		return
	}
	a.showWindow()
}

func (a *App) onTrayLeftClick() {
	a.trayClickMu.Lock()
	defer a.trayClickMu.Unlock()
	if a.trayClickTimer != nil {
		a.trayClickTimer.Stop()
		a.trayClickTimer = nil
	}
	now := time.Now()
	if !a.lastTrayClick.IsZero() && now.Sub(a.lastTrayClick) < trayDoubleClick {
		a.lastTrayClick = time.Time{}
		go a.toggleMainWindow()
		return
	}
	a.lastTrayClick = now
	a.trayClickTimer = time.AfterFunc(trayDoubleClick, func() {
		a.trayClickMu.Lock()
		a.trayClickTimer = nil
		a.trayClickMu.Unlock()
		a.showWindow()
	})
}

func (a *App) installDragOverlay() {
	if a.window == nil {
		return
	}
	a.window.ExecJS(dragOverlayJS())
	a.window.ExecJS(fileDropJS())
	a.installVideoBridge()
	a.installMinimalMode()
	a.installDesktopFrontendMarker()
}

// installDesktopFrontendMarker tells the page it is running inside the desktop
// shell and removes a Service Worker an older build may have left behind.
//
// The thin build loads the Dashboard from the server, so without this marker
// the page believed it was a browser and registered the production Service
// Worker. That worker cached the remote chunks in the WebView2 profile and
// kept serving a stale frontend after the server deployed a new build.
//
// The injection runs on every navigation because the page reloads replace the
// JavaScript context — the marker has to be re-applied each time.
func (a *App) installDesktopFrontendMarker() {
	if a.window == nil {
		return
	}
	a.window.ExecJS(desktopFrontendMarkerJS())
}

// installMinimalMode hides the navigation rail for customer-facing shells.
// It is a no-op unless the client was built (or started) in minimal mode.
func (a *App) installMinimalMode() {
	if a.window == nil || !minimalModeEnabled() {
		return
	}
	a.mu.Lock()
	landing := a.minimalLandingPath
	a.mu.Unlock()
	if landing == "" {
		return
	}
	a.window.ExecJS(minimalModeJS(landing))
}

func (a *App) installVideoBridge() {
	if a.window == nil || a.video == nil || a.videoNonce == "" {
		return
	}
	a.window.ExecJS(videoBridgeJS(a.video.base, a.videoNonce))
}

func (a *App) scheduleDragOverlay() {
	go func() {
		for range 40 {
			time.Sleep(250 * time.Millisecond)
			a.installDragOverlay()
			a.installExternalLinks()
		}
	}()
}

func (a *App) requestQuit() {
	a.mu.Lock()
	a.quitting = true
	a.mu.Unlock()
	if a.app != nil {
		a.app.Quit()
	}
}

func main() {
	// A desktop instance owns the GUI and its child server for this user.
	// Reject a second launch before constructing windows or spawning Python.
	// Windows uses a named event, Linux a flock; macOS uses Wails below.
	lock, err := acquireInstanceLock()
	if err != nil {
		if errors.Is(err, errInstanceRunning) {
			log.Print("Octop desktop is already running")
			return
		}
		log.Printf("desktop instance lock: %v", err)
		return
	}
	defer lock.Close()

	// Start the navigation log before anything can navigate: boot problems then
	// leave a trace even when no window is ever shown.
	navLog.start()
	defer navLog.close()

	store := &settingsStore{cur: loadSettings()}
	api := &App{
		store: store,
		sleep: &sleepGuard{},
	}
	api.videoNonce, _ = randomToken()

	app := application.New(application.Options{
		Name:        "Octop",
		Description: "Octop desktop",
		Services: []application.Service{
			application.NewService(api),
		},
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(assets),
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
		},
		Linux: application.LinuxOptions{
			DisableQuitOnLastWindowClosed: true,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		// Windows/Linux acquire early locks; Wails also handles older Windows
		// binaries and macOS launches.
		SingleInstance: singleInstanceOptions(api),
	})
	api.app = app
	attachOpenURLEventListener(app, api.OpenExternal)
	attachFileDropEventListener(app, api)
	attachVideoEventListener(app, api, api.videoNonce)
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(_ *application.ApplicationEvent) {
		applyAppIcon(app)
		lock.listen(func() { application.InvokeAsync(api.showWindow) })
	})

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:                "Octop",
		Width:                1200,
		Height:               800,
		URL:                  "/",
		Frameless:            true,
		AllowSimpleEventEmit: true,
		EnableFileDrop:       true,
		BackgroundColour:     application.NewRGB(247, 248, 250),
	})
	api.window = win
	// Navigation log: records what the webview really loads (and what the page
	// itself reports about failed requests). Appended to ~/.octop/logs/.
	armNavigationLog(win)
	// Arm the readiness listener before app.Run(): the first navigation is
	// what proves the webview is usable, and the event is delivered by the
	// app's event loop, which only starts there. Arming it later — from
	// boot(), once the dashboard URL is known — misses the completion of the
	// embedded shell page, and since the event only fires per navigation the
	// window would sit on the shell page forever.
	armWebviewReady(win, api.markWebviewReady)
	app.Event.On("desktop:toggle-maximise", func(_ *application.CustomEvent) {
		win.ToggleMaximise()
	})
	app.Event.On("desktop:minimise", func(_ *application.CustomEvent) {
		win.Minimise()
	})
	app.Event.On("desktop:close", func(_ *application.CustomEvent) {
		api.hideToTray()
	})
	installDragOverlay := func(_ *application.WindowEvent) { api.scheduleDragOverlay() }
	win.OnWindowEvent(events.Mac.WebViewDidFinishNavigation, installDragOverlay)
	win.OnWindowEvent(events.Windows.WebViewNavigationCompleted, installDragOverlay)
	win.OnWindowEvent(events.Linux.WindowLoadFinished, installDragOverlay)
	settingsWin := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Octop 设置",
		Width:            settingsWindowWidth,
		Height:           settingsWindowOuterHeight(),
		URL:              "/?settings=1",
		Hidden:           true,
		Frameless:        true,
		AlwaysOnTop:      true,
		DisableResize:    true,
		BackgroundColour: application.NewRGB(255, 255, 255),
		Windows: application.WindowsWindow{
			HiddenOnTaskbar: true,
		},
	})
	api.settingsWindow = settingsWin
	app.Event.RegisterApplicationEventHook(events.Mac.ApplicationShouldHandleReopen, func(event *application.ApplicationEvent) {
		event.Cancel()
		restoreMainAfterDockClick(api.window, api.settingsWindow)
	})

	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		api.mu.Lock()
		quit := api.quitting
		api.mu.Unlock()
		if quit {
			return
		}
		e.Cancel()
		api.hideToTray()
	})
	win.OnWindowEvent(events.Common.WindowMinimise, func(_ *application.WindowEvent) {
		if api.store.get().MinimizeToTray {
			api.hideToTray()
		}
	})
	settingsWin.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		e.Cancel()
		settingsWin.Hide()
	})
	settingsWin.OnWindowEvent(events.Common.WindowLostFocus, func(_ *application.WindowEvent) {
		settingsWin.Hide()
	})

	tray := app.SystemTray.New()
	applyTrayIcon(tray)
	tray.SetTooltip("Octop")
	tray.AttachWindow(settingsWin).WindowOffset(6)
	showSettings := func() { tray.ShowWindow() }
	if trayLeftClickShowsSettings(runtime.GOOS) {
		tray.OnClick(showSettings)
	} else {
		tray.OnClick(func() { api.onTrayLeftClick() })
	}
	tray.OnRightClick(showSettings)

	if _, err := api.setAutostart(store.get().Autostart); err != nil {
		log.Printf("sync autostart: %v", err)
	}
	if err := api.sleep.set(store.get().PreventSleep); err != nil {
		log.Printf("enable sleep prevention: %v", err)
	}

	api.scheduleDragOverlay()
	go api.boot()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
