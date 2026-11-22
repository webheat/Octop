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

func TestLocalLibraryArchiveGroups(t *testing.T) {
	parent := t.TempDir()
	store, err := newLocalLibraryStore("https://ocbot.aixifs.com/videogen", "1", parent)
	if err != nil {
		t.Fatal(err)
	}
	a1, _ := store.Add("a.jpg", "image/jpeg", []byte("alpha-pic"), map[string]any{"group": "登山包", "category": "箱包"})
	a2, _ := store.Add("b.jpg", "image/jpeg", []byte("beta-pic"), map[string]any{"group": "登山包", "category": "箱包"})
	a3, _ := store.Add("c.jpg", "image/jpeg", []byte("gamma-pic"), map[string]any{"group": "跑鞋", "category": "鞋履"})

	result, err := store.ArchiveGroups([]localArchiveGroup{
		{
			Name: "登山包", Category: "箱包", SellingPoints: []string{"耐用"},
			ItemIDs: []string{a1.ID, a2.ID},
		},
		{Name: "跑鞋", Category: "鞋履", ItemIDs: []string{a3.ID}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["createdProducts"] != 2 || result["filedAssets"] != 3 {
		t.Fatalf("unexpected archive result: %#v", result)
	}
	products, _ := store.ListProducts()
	if len(products) != 2 {
		t.Fatalf("want 2 products, got %d", len(products))
	}
	bagID := ""
	for _, p := range products {
		if p["name"] == "登山包" {
			bagID = p["id"].(string)
		}
	}
	if bagID == "" {
		t.Fatal("登山包 product not found")
	}
	bagAssets, _ := store.ProductAssets(bagID)
	if len(bagAssets) != 2 {
		t.Fatalf("want 2 assets in 登山包, got %d", len(bagAssets))
	}
	// Re-importing an archived asset must keep its product ownership.
	re, _ := store.Add("a.jpg", "image/jpeg", []byte("alpha-pic"), nil)
	if re.ProductID != bagID {
		t.Fatalf("re-add lost product id: %q != %q", re.ProductID, bagID)
	}
	// Reuse an existing product for a new group.
	_, err = store.ArchiveGroups([]localArchiveGroup{{ProductID: bagID, ItemIDs: []string{}}})
	if err != nil {
		t.Fatalf("reuse existing product failed: %v", err)
	}
	products, _ = store.ListProducts()
	if len(products) != 2 {
		t.Fatalf("reuse should not create a product, got %d", len(products))
	}
}
