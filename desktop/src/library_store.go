package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Local-first product library storage. The material bytes and their
// classification live on the client machine; the remote server is only used
// transiently for AI recognition. See docs/PRD.md §3.7.

const (
	localLibraryVersion   = 1
	localLibraryIndexName = "index.json"
	localLibraryAssetsDir = "assets"
)

var (
	errLibraryNotFound = errors.New("LIBRARY_NOT_FOUND")
	errLibraryInvalid  = errors.New("LIBRARY_INVALID")
	errLibraryIO       = errors.New("LIBRARY_IO")
)

type localAsset struct {
	ID               string   `json:"id"`
	Filename         string   `json:"filename"`
	MediaType        string   `json:"mediaType"`
	Bytes            int64    `json:"bytes"`
	SHA256           string   `json:"sha256"`
	Group            string   `json:"group,omitempty"`
	Category         string   `json:"category,omitempty"`
	Description      string   `json:"description,omitempty"`
	RecognitionError string   `json:"recognitionError,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	Usage            string   `json:"usage,omitempty"`
	ProductID        string   `json:"productId,omitempty"`
	StoredName       string   `json:"storedName"`
	CreatedAt        int64    `json:"createdAt"`
}

// localProduct is a product archived into the on-machine library. It is the
// local counterpart of the hosted product_library_products row.
type localProduct struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Model         string   `json:"model,omitempty"`
	Category      string   `json:"category,omitempty"`
	SellingPoints []string `json:"sellingPoints,omitempty"`
	CreatedAt     int64    `json:"createdAt"`
}

type localLibraryIndex struct {
	Version  int            `json:"version"`
	Assets   []localAsset   `json:"assets"`
	Products []localProduct `json:"products,omitempty"`
}

// localLibraryStore owns one owner's library under a stable root. All public
// methods are safe for concurrent use.
type localLibraryStore struct {
	mu   sync.Mutex
	root string
}

// newLocalLibraryStore derives an isolated root from the dashboard base URL
// and the owner id, mirroring videoManager's server/owner scoping.
func newLocalLibraryStore(base, owner, rootParent string) (*localLibraryStore, error) {
	if base == "" || owner == "" {
		return nil, errLibraryInvalid
	}
	scope := sha256.Sum256([]byte(base))
	ownerSum := sha256.Sum256([]byte(owner))
	root := filepath.Join(
		rootParent,
		"desktop-library",
		hex.EncodeToString(scope[:8]),
		hex.EncodeToString(ownerSum[:8]),
	)
	if err := os.MkdirAll(filepath.Join(root, localLibraryAssetsDir), 0700); err != nil {
		return nil, errLibraryIO
	}
	return &localLibraryStore{root: root}, nil
}

func (s *localLibraryStore) indexPath() string {
	return filepath.Join(s.root, localLibraryIndexName)
}

func (s *localLibraryStore) loadLocked() (localLibraryIndex, error) {
	idx := localLibraryIndex{
		Version:  localLibraryVersion,
		Assets:   []localAsset{},
		Products: []localProduct{},
	}
	data, err := os.ReadFile(s.indexPath())
	if errors.Is(err, os.ErrNotExist) {
		return idx, nil
	}
	if err != nil {
		return idx, errLibraryIO
	}
	if json.Unmarshal(data, &idx) != nil || idx.Version != localLibraryVersion {
		return localLibraryIndex{}, errLibraryInvalid
	}
	if idx.Assets == nil {
		idx.Assets = []localAsset{}
	}
	if idx.Products == nil {
		idx.Products = []localProduct{}
	}
	return idx, nil
}

func (s *localLibraryStore) saveLocked(idx localLibraryIndex) error {
	idx.Version = localLibraryVersion
	sort.Slice(idx.Assets, func(i, j int) bool { return idx.Assets[i].CreatedAt < idx.Assets[j].CreatedAt })
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return errLibraryIO
	}
	tmp := s.indexPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return errLibraryIO
	}
	if err := os.Rename(tmp, s.indexPath()); err != nil {
		return errLibraryIO
	}
	return nil
}

func safeAssetName(name string) string {
	clean := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	clean = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == 0 {
			return '_'
		}
		return r
	}, clean)
	if clean == "." || clean == ".." || clean == "" {
		return "asset"
	}
	return clean
}

func assetIDFor(data []byte) string {
	sum := sha256.Sum256(data)
	return "L" + hex.EncodeToString(sum[:12])
}

// Add writes the bytes to disk and records (or refreshes) their metadata. The
// SHA-256 doubles as a content-addressed id so re-importing the same image is
// idempotent.
func (s *localLibraryStore) Add(filename, mediaType string, data []byte, meta map[string]any) (localAsset, error) {
	if len(data) == 0 {
		return localAsset{}, errLibraryInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return localAsset{}, err
	}
	id := assetIDFor(data)
	stored := id + "-" + safeAssetName(filename)
	dst := filepath.Join(s.root, localLibraryAssetsDir, stored)
	if fi, statErr := os.Stat(dst); statErr != nil || fi.Size() != int64(len(data)) {
		if err := os.WriteFile(dst, data, 0600); err != nil {
			return localAsset{}, errLibraryIO
		}
	}
	sum := sha256.Sum256(data)
	asset := localAsset{
		ID: id, Filename: filename, MediaType: mediaType,
		Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]),
		StoredName: stored, CreatedAt: time.Now().Unix(),
	}
	asset.Group = stringField(meta, "group")
	asset.Category = stringField(meta, "category")
	asset.Description = stringField(meta, "description")
	asset.RecognitionError = stringField(meta, "recognitionError")
	asset.Usage = stringField(meta, "usage")
	asset.Tags = stringSliceField(meta, "tags")
	replaced := false
	for i := range idx.Assets {
		if idx.Assets[i].ID == id {
			// Keep the first import's identity (filename/stored name) and any
			// classification the caller did not supply this time.
			existing := idx.Assets[i]
			asset.Filename = existing.Filename
			asset.StoredName = existing.StoredName
			asset.CreatedAt = existing.CreatedAt
			asset.ProductID = existing.ProductID
			if _, attempted := meta["recognitionError"]; !attempted {
				asset.RecognitionError = existing.RecognitionError
			}
			if asset.Group == "" {
				asset.Group = existing.Group
			}
			if asset.Category == "" {
				asset.Category = existing.Category
			}
			if asset.Description == "" {
				asset.Description = existing.Description
			}
			if len(asset.Tags) == 0 {
				asset.Tags = existing.Tags
			}
			idx.Assets[i] = asset
			replaced = true
			break
		}
	}
	if !replaced {
		idx.Assets = append(idx.Assets, asset)
	}
	if err := s.saveLocked(idx); err != nil {
		return localAsset{}, err
	}
	return asset, nil
}

// UpdateMeta patches classification fields without touching bytes.
func (s *localLibraryStore) UpdateMeta(id string, meta map[string]any) (localAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return localAsset{}, err
	}
	for i := range idx.Assets {
		if idx.Assets[i].ID == id {
			if v, ok := meta["group"]; ok {
				idx.Assets[i].Group = fmt.Sprint(v)
			}
			if v, ok := meta["category"]; ok {
				idx.Assets[i].Category = fmt.Sprint(v)
			}
			if v, ok := meta["recognitionError"]; ok {
				idx.Assets[i].RecognitionError = fmt.Sprint(v)
			}
			if v, ok := meta["description"]; ok {
				idx.Assets[i].Description = fmt.Sprint(v)
			}
			if _, ok := meta["tags"]; ok {
				idx.Assets[i].Tags = stringSliceField(meta, "tags")
			}
			if err := s.saveLocked(idx); err != nil {
				return localAsset{}, err
			}
			return idx.Assets[i], nil
		}
	}
	return localAsset{}, errLibraryNotFound
}

// List returns a copy of the metadata index (never includes raw bytes).
func (s *localLibraryStore) List() ([]localAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	out := make([]localAsset, len(idx.Assets))
	copy(out, idx.Assets)
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

// localArchiveGroup is one reviewed group from the AI plan. Empty ProductID
// means "create a new product from Name"; a non-empty ProductID reuses an
// existing owned product.
type localArchiveGroup struct {
	ProductID     string   `json:"productId"`
	Name          string   `json:"name"`
	Model         string   `json:"model"`
	Category      string   `json:"category"`
	SellingPoints []string `json:"sellingPoints"`
	ItemIDs       []string `json:"itemIds"`
}

// ArchiveGroups commits a reviewed grouping plan into local products and files
// each asset under its product. It is idempotent: reusing a ProductID keeps the
// product; re-archiving an asset just moves its ProductID. Missing asset ids
// are reported, not fatal. Product ids are locally minted (P + 12-hex of a
// SHA-256 over name+timestamp+random-free counter derived from existing ids).
func (s *localLibraryStore) ArchiveGroups(groups []localArchiveGroup) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	assetByID := make(map[string]int, len(idx.Assets))
	for i := range idx.Assets {
		assetByID[idx.Assets[i].ID] = i
	}
	productByID := make(map[string]int, len(idx.Products))
	for i := range idx.Products {
		productByID[idx.Products[i].ID] = i
	}
	created, reused, filed := 0, 0, 0
	missing := []string{}
	for _, group := range groups {
		productID := strings.TrimSpace(group.ProductID)
		if productID != "" {
			if _, ok := productByID[productID]; !ok {
				return nil, errLibraryNotFound
			}
			reused++
		} else {
			name := strings.TrimSpace(group.Name)
			if name == "" {
				continue
			}
			productID = newLocalProductID(name, len(idx.Products), time.Now().UnixNano())
			idx.Products = append(idx.Products, localProduct{
				ID: productID, Name: name[:min(len(name), 200)],
				Model: group.Model, Category: group.Category,
				SellingPoints: group.SellingPoints, CreatedAt: time.Now().Unix(),
			})
			productByID[productID] = len(idx.Products) - 1
			created++
		}
		for _, aid := range group.ItemIDs {
			pos, ok := assetByID[aid]
			if !ok {
				missing = append(missing, aid)
				continue
			}
			idx.Assets[pos].ProductID = productID
			idx.Assets[pos].Usage = "scene"
			filed++
		}
	}
	if err := s.saveLocked(idx); err != nil {
		return nil, err
	}
	return map[string]any{
		"createdProducts": created,
		"reusedProducts":  reused,
		"filedAssets":     filed,
		"missingAssets":   missing,
	}, nil
}

func newLocalProductID(name string, salt int, ts int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", name, salt, ts)))
	return "P" + hex.EncodeToString(sum[:12])
}

// ListProducts returns all local products with their asset counts.
func (s *localLibraryStore) ListProducts() ([]map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int, len(idx.Products))
	for _, asset := range idx.Assets {
		if asset.ProductID != "" {
			counts[asset.ProductID]++
		}
	}
	out := make([]map[string]any, 0, len(idx.Products))
	for _, p := range idx.Products {
		out = append(out, map[string]any{
			"id": p.ID, "name": p.Name, "model": p.Model, "category": p.Category,
			"sellingPoints": p.SellingPoints, "assetCount": counts[p.ID],
			"createdAt": p.CreatedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		ti, _ := out[i]["createdAt"].(int64)
		tj, _ := out[j]["createdAt"].(int64)
		return ti < tj
	})
	return out, nil
}

// ProductAssets returns the assets filed under a product.
func (s *localLibraryStore) ProductAssets(productID string) ([]localAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	out := []localAsset{}
	for _, asset := range idx.Assets {
		if asset.ProductID == productID {
			out = append(out, asset)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

// AssetPath resolves a stored asset to an absolute path, guarding against
// traversal via a forged StoredName.
func (s *localLibraryStore) AssetPath(id string) (string, localAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return "", localAsset{}, err
	}
	for _, asset := range idx.Assets {
		if asset.ID == id {
			path := filepath.Join(s.root, localLibraryAssetsDir, filepath.Base(asset.StoredName))
			if fi, statErr := os.Stat(path); statErr != nil || !fi.Mode().IsRegular() {
				return "", asset, errLibraryNotFound
			}
			return path, asset, nil
		}
	}
	return "", localAsset{}, errLibraryNotFound
}

// Read returns the raw bytes of one asset.
func (s *localLibraryStore) Read(id string) ([]byte, localAsset, error) {
	path, asset, err := s.AssetPath(id)
	if err != nil {
		return nil, asset, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, asset, errLibraryIO
	}
	return data, asset, nil
}

// Remove deletes one asset's bytes and metadata.
func (s *localLibraryStore) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, err := s.loadLocked()
	if err != nil {
		return err
	}
	for i, asset := range idx.Assets {
		if asset.ID == id {
			_ = os.Remove(filepath.Join(s.root, localLibraryAssetsDir, filepath.Base(asset.StoredName)))
			idx.Assets = append(idx.Assets[:i], idx.Assets[i+1:]...)
			return s.saveLocked(idx)
		}
	}
	return errLibraryNotFound
}

// CopyInto writes all referenced assets into a render project's assets dir.
// The exportName map is scene asset basename -> local asset id.
func (s *localLibraryStore) CopyInto(destDir string, wanted map[string]string) error {
	if len(wanted) == 0 {
		return nil
	}
	if err := os.MkdirAll(destDir, 0700); err != nil {
		return errLibraryIO
	}
	for exportName, id := range wanted {
		if exportName != safeAssetName(exportName) {
			return errLibraryInvalid
		}
		src, _, err := s.AssetPath(id)
		if err != nil {
			return err
		}
		in, err := os.Open(src)
		if err != nil {
			return errLibraryIO
		}
		out, err := os.OpenFile(filepath.Join(destDir, exportName), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			_ = in.Close()
			if errors.Is(err, os.ErrExist) {
				continue
			}
			return errLibraryIO
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		_ = in.Close()
		if copyErr != nil || closeErr != nil {
			return errLibraryIO
		}
	}
	return nil
}

func stringField(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	if v, ok := meta[key]; ok && v != nil {
		return fmt.Sprint(v)
	}
	return ""
}

func stringSliceField(meta map[string]any, key string) []string {
	if meta == nil {
		return nil
	}
	raw, ok := meta[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if v != nil {
			out = append(out, fmt.Sprint(v))
		}
	}
	return out
}
