package main

import "testing"

func withMinimalMode(t *testing.T, build string) {
	t.Helper()
	old := defaultMinimalMode
	defaultMinimalMode = build
	t.Cleanup(func() { defaultMinimalMode = old })
}

func TestMinimalModeDisabledKeepsBase(t *testing.T) {
	withMinimalMode(t, "")
	t.Setenv("OCTOP_DESKTOP_MINIMAL", "0")
	base := "https://host/videogen/"
	if got := minimalDashboardURL(base); got != base {
		t.Fatalf("disabled mode must not touch the base: got %q", got)
	}
}

func TestMinimalModeLandsOnProductLibrary(t *testing.T) {
	withMinimalMode(t, "1")
	t.Setenv("OCTOP_DESKTOP_MINIMAL", "")
	if got := minimalDashboardURL("https://host/videogen"); got != "https://host/videogen/product-library" {
		t.Fatalf("unexpected landing URL: %q", got)
	}
	if got := minimalDashboardURL("https://host/videogen/"); got != "https://host/videogen/product-library" {
		t.Fatalf("trailing slash must be trimmed: %q", got)
	}
	if got := minimalDashboardURL(""); got != "" {
		t.Fatalf("empty base must stay empty: %q", got)
	}
}

func TestMinimalModeEnvOverridesBuildDefault(t *testing.T) {
	withMinimalMode(t, "1")
	t.Setenv("OCTOP_DESKTOP_MINIMAL", "0")
	if minimalModeEnabled() {
		t.Fatal("env override must win over the build-time default")
	}
	base := "https://host/videogen"
	if got := minimalDashboardURL(base); got != base {
		t.Fatalf("disabled override changed the base: %q", got)
	}
}

func TestMinimalModeJSIsOneShotFallback(t *testing.T) {
	js := minimalModeJS("/videogen/product-library")
	if js == "" {
		t.Fatal("expected an injection script")
	}
	for _, needle := range []string{"__octopMinimalMode", "F9", "data-octop-minimal-native", "nativeHandled()"} {
		if !contains(js, needle) {
			t.Fatalf("fallback injection is missing %q", needle)
		}
	}
	// The old "keep the user on the landing page" machinery is gone: no DOM
	// observer, no history rewrite and no polling timer.
	for _, banned := range []string{"MutationObserver", "setInterval", "replaceState", "popstate", "keepLanding"} {
		if contains(js, banned) {
			t.Fatalf("fallback injection must not force navigation (%q found)", banned)
		}
	}
}

func TestLandingPath(t *testing.T) {
	if got := landingPath("https://host/videogen/product-library"); got != "/videogen/product-library" {
		t.Fatalf("unexpected landing path: %q", got)
	}
	if got := landingPath("not a url"); got != "" {
		t.Fatalf("invalid URL must not produce a path: %q", got)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
