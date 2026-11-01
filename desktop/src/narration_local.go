package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// synthesizeLocalNarration renders the narration lines of a package with the
// operating system's speech engine.
//
// The server ships narration lines without audio for the free tier: the
// client fills them in here so the finished video carries a voice without the
// server spending anything. Paid packages already contain rendered clips and
// are left untouched.
//
// The local engine speaks noticeably slower than the server-side one, so the
// clip lengths are measured here and the scene durations are corrected
// afterwards — otherwise the narration would be cut off by the next cut.
//
// Failures are reported to the caller but never abort the render: a silent
// video is better than no video.
func synthesizeLocalNarration(dataDir string) error {
	planPath := filepath.Join(dataDir, "audio.json")
	raw, err := os.ReadFile(planPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var plan audioPlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		return err
	}
	if plan.Narration.Mode != "local" {
		return nil
	}
	if len(plan.Scenes) == 0 {
		return nil
	}

	assetsDir := filepath.Join(dataDir, "assets")
	if err := os.MkdirAll(assetsDir, 0700); err != nil {
		return err
	}
	bar := plan.BGM.Bar
	if bar <= 0 {
		bar = 2.0
	}

	// Sort the ids so the clips are produced in a stable order.
	ids := make([]string, 0, len(plan.Scenes))
	for id := range plan.Scenes {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var failures int
	var attempted int
	measured := map[string]float64{}
	for _, id := range ids {
		scene := plan.Scenes[id]
		line := strings.TrimSpace(scene.Narration)
		if line == "" {
			continue
		}
		name := strings.TrimSpace(scene.Audio.Src)
		if name == "" || strings.ContainsAny(name, `/\`) || name != filepath.Base(name) {
			continue
		}
		attempted++
		target := filepath.Join(assetsDir, name)
		if info, err := os.Stat(target); err == nil && info.Size() > 0 {
			if seconds, ok := wavDuration(target); ok {
				measured[id] = seconds
			}
			continue // already rendered
		}
		if _, err := synthesizeToWav(line, target); err != nil {
			failures++
			continue
		}
		if seconds, ok := wavDuration(target); ok {
			measured[id] = seconds
		}
	}
	if len(measured) > 0 {
		if err := applyMeasuredDurations(planPath, plan, measured, bar); err != nil {
			return err
		}
	}
	if failures > 0 {
		return &narrationError{failed: failures, total: attempted}
	}
	return nil
}

// applyMeasuredDurations rewrites the audio plan so each scene is long enough
// to hold its narration, rounded up to whole bars.
func applyMeasuredDurations(
	planPath string, plan audioPlan, measured map[string]float64, bar float64,
) error {
	changed := false
	for id, seconds := range measured {
		scene, ok := plan.Scenes[id]
		if !ok {
			continue
		}
		required := seconds + 0.35
		if scene.Duration >= required {
			continue
		}
		bars := math.Ceil(required/bar - 1e-9)
		if bars < 1 {
			bars = 1
		}
		scene.Duration = math.Round(bars*bar*1000) / 1000
		plan.Scenes[id] = scene
		changed = true
	}
	if !changed {
		return nil
	}
	payload, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(planPath, payload, 0600)
}

// wavDuration reads the duration of a PCM WAV file from its header.
func wavDuration(path string) (float64, bool) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 44 {
		return 0, false
	}
	if string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return 0, false
	}
	// Walk the chunk list: "fmt " carries the format, "data" the samples.
	offset := 12
	var byteRate uint32
	var dataSize uint32
	for offset+8 <= len(data) {
		id := string(data[offset : offset+4])
		size := binary.LittleEndian.Uint32(data[offset+4 : offset+8])
		body := offset + 8
		switch id {
		case "fmt ":
			if body+16 > len(data) {
				return 0, false
			}
			byteRate = binary.LittleEndian.Uint32(data[body+8 : body+12])
		case "data":
			dataSize = size
		}
		if id == "data" {
			break
		}
		offset = body + int(size)
		if size%2 == 1 {
			offset++
		}
	}
	if byteRate == 0 || dataSize == 0 {
		return 0, false
	}
	return float64(dataSize) / float64(byteRate), true
}

// narrationError reports how many lines could not be synthesised.
type narrationError struct {
	failed int
	total  int
}

func (e *narrationError) Error() string {
	return fmt.Sprintf("narration: %d of %d lines failed", e.failed, e.total)
}
