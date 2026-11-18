// Package bootstrap turns a slim installer into a working desktop client.
//
// The shell ships without a runtime, so the first launch does the work: it
// downloads the portable runtime, verifies it, and unpacks it into place.
// Every step is resumable — partial downloads stay on disk, finished parts
// are remembered in state.json, and a mirror that fails hands over to the
// next one.
package bootstrap

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Part is one downloadable piece of the runtime.
type Part struct {
	ID   string   `json:"id"`
	URLs []string `json:"urls"`
	// Size is the expected download size in bytes. Zero means "ask the
	// server".
	Size int64 `json:"size,omitempty"`
	// SHA256 is the checksum of the downloaded archive. When empty the
	// archive is only checked for consistency with a previous download.
	SHA256 string `json:"sha256,omitempty"`
	// Format is "zip" or "tar.gz". Empty means "infer it from the file name".
	Format string `json:"format,omitempty"`
	// Target is the directory under the runtime root the part unpacks into.
	// Empty means the runtime root itself; at most one part may do that.
	Target string `json:"target,omitempty"`
	// StripRoot drops the single top-level directory of the archive.
	StripRoot bool `json:"stripRoot,omitempty"`
	// Required parts must be installed before the runtime can start.
	Required bool `json:"required"`
}

// Manifest is everything a slim installer needs to build its runtime.
type Manifest struct {
	Version  string `json:"version"`
	Platform string `json:"platform,omitempty"`
	Parts    []Part `json:"parts"`
}

// Progress reports how far a part download has come.
type Progress struct {
	PartID   string
	Received int64
	Total    int64
}

// Percent returns the download progress in percent, 0 when the size is unknown.
func (p Progress) Percent() int {
	if p.Total <= 0 {
		return 0
	}
	percent := int(p.Received * 100 / p.Total)
	if percent > 100 {
		return 100
	}
	return percent
}

// Options configures a bootstrap run.
type Options struct {
	// Root is the runtime directory the parts are unpacked into.
	Root string
	// CacheDir holds the downloaded archives and state.json. It must live
	// outside Root: the shell wipes and re-creates Root on every upgrade.
	CacheDir string
	// Manifest lists the parts to install.
	Manifest Manifest
	// Progress is called while bytes arrive.
	Progress func(Progress)
	// Log receives diagnostics; it may be nil.
	Log func(format string, args ...any)
	// Client performs the HTTP requests; nil means DefaultClient.
	Client *http.Client
	// MaxBytes caps a single download; zero means DefaultMaxBytes.
	MaxBytes int64
	// Attempts is how many times one mirror is tried before the next one
	// takes over; zero means DefaultAttempts.
	Attempts int
	// Backoff is the pause between two attempts on the same mirror; an empty
	// slice means DefaultBackoff.
	Backoff []time.Duration
	// Merge allows one root part to coexist with parts targeting subpaths of
	// the same root. In merge mode parts are installed in manifest order and
	// the root part must come first: its Extract wipes Root, so any part that
	// follows must live under a distinct Target. This is how the video runtime
	// installs a core part plus an optional headless-shell subtree.
	Merge bool
}

const (
	// DefaultMaxBytes caps a runtime download. The portable payload is
	// roughly 290 MB compressed; the cap leaves headroom for growth without
	// letting a wrong URL fill the disk.
	DefaultMaxBytes int64 = 512 << 20
	// DefaultAttempts is how often one mirror is tried before the next one
	// takes over.
	DefaultAttempts = 3
)

// DefaultBackoff is the pause between two attempts on the same mirror.
var DefaultBackoff = []time.Duration{time.Second, 4 * time.Second}

// Run downloads and unpacks every required part of the manifest into Root.
func Run(opts Options) error {
	if opts.Root == "" {
		return errors.New("bootstrap: no runtime root")
	}
	if len(opts.Manifest.Parts) == 0 {
		return errors.New("bootstrap: the manifest lists no parts")
	}
	if err := validateParts(opts.Manifest.Parts, opts.Merge); err != nil {
		return err
	}
	if opts.CacheDir == "" {
		opts.CacheDir = filepath.Join(opts.Root, ".cache")
	}
	if opts.Client == nil {
		opts.Client = DefaultClient()
	}
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DefaultMaxBytes
	}
	if opts.Attempts <= 0 {
		opts.Attempts = DefaultAttempts
	}
	if len(opts.Backoff) == 0 {
		opts.Backoff = DefaultBackoff
	}
	log := opts.Log
	if log == nil {
		log = func(string, ...any) {}
	}

	statePath := filepath.Join(opts.CacheDir, "state.json")
	state, err := loadState(statePath)
	if err != nil {
		return err
	}
	if state.Version != opts.Manifest.Version {
		// A new runtime means the old archives no longer apply.
		log("bootstrap: runtime %s replaces %s", opts.Manifest.Version, state.Version)
		state = &State{Version: opts.Manifest.Version, Parts: map[string]PartState{}}
		if err := os.RemoveAll(filepath.Join(opts.CacheDir, "parts")); err != nil {
			return err
		}
	}
	state.Version = opts.Manifest.Version

	f := &fetcher{opts: opts, log: log}
	for _, part := range opts.Manifest.Parts {
		if !part.Required {
			log("bootstrap: skipping optional part %q", part.ID)
			continue
		}
		if err := f.install(part, state, statePath); err != nil {
			return fmt.Errorf("bootstrap: part %q: %w", part.ID, err)
		}
	}
	return state.save(statePath)
}

// validateParts rejects manifests the installer cannot act on.
func validateParts(parts []Part, merge bool) error {
	roots := 0
	for i, part := range parts {
		if part.ID == "" {
			return errors.New("bootstrap: a part has no id")
		}
		if len(part.URLs) == 0 {
			return fmt.Errorf("bootstrap: part %q has no url", part.ID)
		}
		if part.Target == "" {
			roots++
			if merge && i != 0 {
				return errors.New("bootstrap: in merge mode the root part must come first")
			}
		}
	}
	if roots > 1 {
		return errors.New("bootstrap: more than one part targets the runtime root")
	}
	if !merge && roots == 1 && len(parts) > 1 {
		// The root part owns everything below it — another part would be
		// wiped out by it. In merge mode this is allowed because the root
		// part is required to come first and later parts use distinct Targets.
		return errors.New("bootstrap: a part targeting the runtime root cannot be combined with other parts")
	}
	return nil
}

// archivePath is where the downloaded archive of a part is cached.
func (f *fetcher) archivePath(part Part) string {
	name := part.ID
	switch {
	case strings.HasSuffix(part.Format, "zip"):
		name += ".zip"
	case strings.HasSuffix(part.Format, "tar.gz"):
		name += ".tar.gz"
	default:
		name += ".archive"
	}
	return filepath.Join(f.opts.CacheDir, "parts", name)
}

// install makes sure the part is on disk, verified, and unpacked into place.
func (f *fetcher) install(part Part, state *State, statePath string) error {
	archive := f.archivePath(part)
	if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
		return err
	}

	cached, cachedOK := state.Parts[part.ID]
	expected := part.SHA256
	if expected == "" && cachedOK {
		// No checksum in the manifest — fall back to the one recorded for
		// the previous download so a swapped mirror cannot slip through.
		expected = cached.Expected
	}
	// A cached archive may only be reused when this download started it.
	// Otherwise it belongs to another version and must not be resumed into.
	reusable := cachedOK && cached.Expected == expected
	if !reusable {
		if err := os.Remove(archive); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		cached = PartState{}
	}
	if reusable && cached.SHA256 != "" && fileExists(archive) {
		sum, err := fileSHA256(archive)
		if err == nil && (expected == "" || strings.EqualFold(sum, expected)) {
			f.log("bootstrap: reusing the cached %s archive", part.ID)
			return f.unpack(part, archive)
		}
		// The cached archive is damaged — fetch it again.
		if err := os.Remove(archive); err != nil {
			return err
		}
	}

	// Record the download before it starts, so an interrupted run knows that
	// the file on disk belongs to this download and may be resumed.
	state.Parts[part.ID] = PartState{Expected: expected}
	if err := state.save(statePath); err != nil {
		return err
	}
	if err := f.fetch(part, archive, expected); err != nil {
		return err
	}
	sum, err := fileSHA256(archive)
	if err != nil {
		return err
	}
	size := int64(0)
	if info, statErr := os.Stat(archive); statErr == nil {
		size = info.Size()
	}
	state.Parts[part.ID] = PartState{
		Expected: expected,
		SHA256:   sum,
		Size:     size,
		At:       time.Now().UTC().Format(time.RFC3339),
	}
	// Record the finished download before unpacking: a crash while
	// unpacking must not cost the download again.
	if err := state.save(statePath); err != nil {
		return err
	}
	return f.unpack(part, archive)
}

// unpack extracts the cached archive into the runtime root.
func (f *fetcher) unpack(part Part, archive string) error {
	dest := f.opts.Root
	if part.Target != "" {
		dest = filepath.Join(f.opts.Root, filepath.FromSlash(part.Target))
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return Extract(archive, dest, part.Format, part.StripRoot)
}
