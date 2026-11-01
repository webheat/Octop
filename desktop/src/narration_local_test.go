package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSynthesizeLocalNarration proves the client fills in the narration
// clips declared by audio.json.
func TestSynthesizeLocalNarration(t *testing.T) {
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assets, 0700); err != nil {
		t.Fatal(err)
	}
	plan := `{
      "narration": {"mode": "local", "engine": "sapi"},
      "scenes": {
        "s1": {"narration": "第一句中文", "audio": {"src": "voice-s1.wav"}},
        "s2": {"narration": "第二句中文", "audio": {"src": "voice-s2.wav"}},
        "s3": {"duration": 4.0}
      }
    }`
	if err := os.WriteFile(filepath.Join(dir, "audio.json"), []byte(plan), 0600); err != nil {
		t.Fatal(err)
	}
	if err := synthesizeLocalNarration(dir); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	for _, name := range []string{"voice-s1.wav", "voice-s2.wav"} {
		info, err := os.Stat(filepath.Join(assets, name))
		if err != nil {
			t.Fatalf("expected %s: %v", name, err)
		}
		if info.Size() < 44 {
			t.Fatalf("%s is too small: %d bytes", name, info.Size())
		}
	}
	// A scene without narration must not produce a file.
	if _, err := os.Stat(filepath.Join(assets, "voice-s3.wav")); !os.IsNotExist(err) {
		t.Fatal("expected no clip for a scene without narration")
	}
}

// TestSynthesizeLocalNarrationSkipsOtherModes makes sure paid packages
// (whose clips are rendered by the server) are left alone.
func TestSynthesizeLocalNarrationSkipsOtherModes(t *testing.T) {
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assets, 0700); err != nil {
		t.Fatal(err)
	}
	plan := `{
      "narration": {"mode": "bundled", "engine": "minimax"},
      "scenes": {"s1": {"narration": "服务端合成", "audio": {"src": "voice-s1.mp3"}}}
    }`
	if err := os.WriteFile(filepath.Join(dir, "audio.json"), []byte(plan), 0600); err != nil {
		t.Fatal(err)
	}
	if err := synthesizeLocalNarration(dir); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	entries, err := os.ReadDir(assets)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no generated clips, found %d", len(entries))
	}
}

// TestSynthesizeLocalNarrationWithoutPlan makes a package without an audio
// plan a no-op instead of an error.
func TestSynthesizeLocalNarrationWithoutPlan(t *testing.T) {
	dir := t.TempDir()
	if err := synthesizeLocalNarration(dir); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

// TestSynthesizeLocalNarrationRejectsTraversal makes sure a hostile plan
// cannot write outside the assets directory.
func TestSynthesizeLocalNarrationRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assets, 0700); err != nil {
		t.Fatal(err)
	}
	plan := `{
      "narration": {"mode": "local"},
      "scenes": {"s1": {"narration": "越界", "audio": {"src": "../escaped.wav"}}}
    }`
	if err := os.WriteFile(filepath.Join(dir, "audio.json"), []byte(plan), 0600); err != nil {
		t.Fatal(err)
	}
	if err := synthesizeLocalNarration(dir); err != nil {
		t.Fatalf("synthesize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "escaped.wav")); !os.IsNotExist(err) {
		t.Fatal("expected no file outside assets/")
	}
}
