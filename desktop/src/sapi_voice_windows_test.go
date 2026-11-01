//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSynthesizeToWav proves the local SAPI path produces a real WAV file.
// It is skipped in environments without a speech engine.
func TestSynthesizeToWav(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "voice.wav")
	name, err := synthesizeToWav("测试中文语音合成", out)
	if err != nil {
		t.Skipf("speech engine unavailable: %v", err)
	}
	if name == "" {
		t.Fatal("expected a voice name")
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatalf("stat output: %v", err)
	}
	if info.Size() < 44 {
		t.Fatalf("expected a WAV header, got %d bytes", info.Size())
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	if string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		t.Fatalf("not a RIFF/WAVE file: %q %q", data[:4], data[8:12])
	}
}

// TestSynthesizeToWavEmptyText rejects blank narration instead of writing a
// silent file.
func TestSynthesizeToWavEmptyText(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "voice.wav")
	if _, err := synthesizeToWav("   ", out); err == nil {
		t.Fatal("expected an error for empty narration")
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatal("expected no file for empty narration")
	}
}
