//go:build !windows

// Local narration is Windows-only: it relies on the SAPI speech engine.
// Other platforms fall back to no local voice, so the free tier renders
// without narration rather than failing.

package main

import "fmt"

// listSAPIVoices reports that no local voice is available.
func listSAPIVoices(_ ...any) []string { return nil }

// synthesizeToWav always reports the unsupported platform.
func synthesizeToWav(text, outPath string) (string, error) {
	return "", fmt.Errorf("local narration is only available on Windows")
}
