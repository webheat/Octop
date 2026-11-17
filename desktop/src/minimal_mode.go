package main

import (
	"net/url"
	"os"
	"strings"
)

// Minimal mode — the customer-facing shell.
//
// The dashboard implements minimal mode natively (see
// dashboard/src/hooks/useDesktopMinimalMode.ts): it detects the video bridge,
// omits the navigation rail and lands on the product library. This injection
// is only a fallback for older dashboard builds — a newer build marks the
// document with data-octop-minimal-native and the injection steps aside.
//
// Enabled at build time with `-X main.defaultMinimalMode=1`, or at runtime
// with `OCTOP_DESKTOP_MINIMAL=1`. `OCTOP_DESKTOP_MINIMAL=0` wins over the
// build-time default so a packaged client can still be turned off.
var defaultMinimalMode string

// minimalDashboardPath is the landing page of minimal mode.
const minimalDashboardPath = "/product-library"

func minimalModeEnabled() bool {
	if v := strings.TrimSpace(os.Getenv("OCTOP_DESKTOP_MINIMAL")); v != "" {
		return !strings.EqualFold(v, "false") && v != "0"
	}
	v := strings.TrimSpace(defaultMinimalMode)
	return v != "" && v != "0" && !strings.EqualFold(v, "false")
}

// minimalDashboardURL points the remote dashboard at the product library.
//
// The base is an API base (scheme + host + mount prefix); the video manager
// still talks to that base, so only the navigation target changes here.
func minimalDashboardURL(base string) string {
	if !minimalModeEnabled() {
		return base
	}
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return base
	}
	return base + minimalDashboardPath
}

// landingPath returns the path of an absolute dashboard URL, e.g.
// "https://host/videogen/product-library" -> "/videogen/product-library".
func landingPath(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Path == "" {
		return ""
	}
	return u.Path
}

// minimalModeJS is a one-shot fallback for older dashboards that do not yet
// implement minimal mode natively: hide the navigation rail once. It does not
// observe the DOM, rewrite history or poll — the user is free to navigate
// wherever the remote frontend takes them. Landing on the product library is
// handled by minimalDashboardURL (initial URL) and by the dashboard itself.
//
// The rail is the first positioned child of the app shell and is 220px wide
// (56px when collapsed), so it can be found without depending on the CSS
// module class names of the deployed build. Ctrl+Shift+F9 restores the rail
// for troubleshooting. Newer dashboards set data-octop-minimal-native and
// this script becomes a no-op.
//
// The landing path parameter is kept for the existing call site; navigation
// is never rewritten here.
func minimalModeJS(_ string) string {
	return `(function(){try{
  if (!window.__octopMinimalMode) {
    var state = { on: true, hidden: [] };
    function nativeHandled() {
      return document.documentElement.getAttribute('data-octop-minimal-native') === '1';
    }
    function isRail(el) {
      if (!el || el.tagName !== 'DIV') return false;
      var cs = window.getComputedStyle(el);
      if (!cs || cs.position !== 'relative') return false;
      var inner = el.firstElementChild;
      if (!inner) return false;
      var w = parseFloat(window.getComputedStyle(inner).width) || 0;
      return w === 220 || w === 56;
    }
    function findRail() {
      var root = document.getElementById('root');
      var app = root && root.firstElementChild;
      if (!app) return null;
      for (var i = 0; i < app.children.length; i++) {
        if (isRail(app.children[i])) return app.children[i];
      }
      return null;
    }
    function hideRail() {
      if (nativeHandled()) return;
      var el = findRail();
      if (el && el.style.display !== 'none') {
        state.hidden.push(el);
        el.style.display = 'none';
      }
      document.documentElement.setAttribute('data-octop-minimal', '1');
    }
    function showRail() {
      for (var i = 0; i < state.hidden.length; i++) {
        state.hidden[i].style.display = '';
      }
      state.hidden = [];
      document.documentElement.removeAttribute('data-octop-minimal');
    }
    window.__octopMinimalMode = {
      apply: hideRail,
      restore: showRail,
      refresh: function () { hideRail(); },
      toggle: function () {
        state.on = !state.on;
        if (state.on) { hideRail(); } else { showRail(); }
      }
    };
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && e.key === 'F9') {
        window.__octopMinimalMode.toggle();
      }
    });
  }
  window.__octopMinimalMode.refresh();
}catch(e){}})();`
}
