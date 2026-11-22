package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalLibraryStoreAddListReadRemove(t *testing.T) {
	store, err := newLocalLibraryStore("https://ocbot.aixifs.com/videogen", "42", t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	data := []byte("fake-image-bytes")
	meta := map[string]any{"group": "Trolley", "tags": []any{"bag", "travel"}}
	asset, err := store.Add("front.jpg", "image/jpeg", data, meta)
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if asset.Group != "Trolley" || len(asset.Tags) != 2 {
		t.Fatalf("meta not stored: %+v", asset)
	}

	// Re-importing identical bytes is idempotent (same id, no duplicate).
	again, err := store.Add("front-copy.jpg", "image/jpeg", data, meta)
	if err != nil {
		t.Fatalf("add again: %v", err)
	}
	if again.ID != asset.ID {
		t.Fatalf("id changed: %s != %s", again.ID, asset.ID)
	}
	listed, err := store.List()
	if err != nil || len(listed) != 1 {
		t.Fatalf("expected 1 asset, got %d (%v)", len(listed), err)
	}

	read, got, err := store.Read(asset.ID)
	if err != nil || string(read) != string(data) || got.Filename != "front.jpg" {
		t.Fatalf("read mismatch: %q %+v %v", read, got, err)
	}

	// CopyInto places the bytes under the export name for rendering.
	dest := t.TempDir()
	if err := store.CopyInto(filepath.Join(dest, "assets"), map[string]string{asset.ID + "-front.jpg": asset.ID}); err != nil {
		t.Fatalf("copy into: %v", err)
	}
	copied, err := os.ReadFile(filepath.Join(dest, "assets", asset.ID+"-front.jpg"))
	if err != nil || string(copied) != string(data) {
		t.Fatalf("copied bytes mismatch: %v", err)
	}

	if err := store.Remove(asset.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	listed, _ = store.List()
	if len(listed) != 0 {
		t.Fatalf("expected empty after remove, got %d", len(listed))
	}
}

func TestLocalLibraryStoreOwnerIsolation(t *testing.T) {
	parent := t.TempDir()
	a, _ := newLocalLibraryStore("https://ocbot.aixifs.com/videogen", "1", parent)
	b, _ := newLocalLibraryStore("https://ocbot.aixifs.com/videogen", "2", parent)
	_, _ = a.Add("x.jpg", "image/jpeg", []byte("alice"), nil)
	la, _ := a.List()
	lb, _ := b.List()
	if len(la) != 1 || len(lb) != 0 {
		t.Fatalf("owner isolation broken: alice=%d bob=%d", len(la), len(lb))
	}
}

func TestSafeAssetName(t *testing.T) {
	cases := map[string]string{
		"a/b/../c.jpg": "c.jpg",
		"..":           "asset",
		"":             "asset",
		"中文 图.jpg":     "中文 图.jpg",
	}
	for in, want := range cases {
		if got := safeAssetName(in); got != want {
			t.Errorf("safeAssetName(%q) = %q, want %q", in, got, want)
		}
	}
}
