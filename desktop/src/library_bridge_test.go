package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLibraryRecognitionRetriesStoredImages(t *testing.T) {
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			t.Error(err)
			return
		}
		files := r.MultipartForm.File["files"]
		if len(files) != 1 || files[0].Header.Get("Content-Type") != "image/png" {
			t.Errorf("wrong upload type: %v", files)
			return
		}
		if fail {
			fmt.Fprint(w, `{"items":[{"error":"model unavailable"}]}`)
			return
		}
		fmt.Fprint(w, `{"items":[{"group":"chair","category":"furniture","description":"chair photo","tags":["wood"]}]}`)
	}))
	defer server.Close()
	app := &App{video: &videoManager{base: server.URL, client: server.Client()}}
	store, err := newLocalLibraryStore(server.URL, "owner", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	asset, err := store.Add("chair.png", "image/png", []byte("image"), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"ids": []string{asset.ID}})
	result, err := app.libraryRecognizeExisting(store, "token", map[string]json.RawMessage{"body": body})
	if err != nil {
		t.Fatal(err)
	}
	item := result.(map[string]any)["items"].([]map[string]any)[0]
	if item["group"] != "chair" {
		t.Fatalf("unexpected result: %#v", item)
	}
	assets, err := store.List()
	if err != nil || assets[0].Category != "furniture" || len(assets[0].Tags) != 1 {
		t.Fatalf("metadata not saved: %#v %v", assets, err)
	}
	fail = true
	result, err = app.libraryRecognizeExisting(store, "token", map[string]json.RawMessage{"body": body})
	if err != nil {
		t.Fatal(err)
	}
	item = result.(map[string]any)["items"].([]map[string]any)[0]
	if item["recognitionError"] != "RECOGNITION_FAILED" {
		t.Fatalf("missing recognition error: %#v", item)
	}
	assets, err = store.List()
	if err != nil || assets[0].Group != "chair" || assets[0].RecognitionError != "RECOGNITION_FAILED" {
		t.Fatalf("failed retry changed metadata: %#v %v", assets, err)
	}
	fail = false
	_, err = app.libraryRecognizeExisting(store, "token", map[string]json.RawMessage{"body": body})
	if err != nil {
		t.Fatal(err)
	}
	assets, err = store.List()
	if err != nil || assets[0].RecognitionError != "" {
		t.Fatalf("success did not clear error: %#v %v", assets, err)
	}
}

func TestLibraryErrorPreservesMissingRuntime(t *testing.T) {
	if got := libraryErrorCode(errors.New("RUNTIME_MISSING")); got != "RUNTIME_MISSING" {
		t.Fatalf("runtime error changed to %q", got)
	}
}
