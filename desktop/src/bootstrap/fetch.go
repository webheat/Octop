package bootstrap

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrChecksumMismatch reports that a downloaded archive does not match the
// checksum the manifest promised.
var ErrChecksumMismatch = errors.New("checksum mismatch")

// errNotFound reports that a mirror does not have the file at all. It ends
// the attempts on that mirror right away — a different mirror may have it.
var errNotFound = errors.New("not found")

// DefaultClient is the HTTP client the bootstrap uses: no total timeout (a
// runtime download may take a while on a slow link) but no hang on a dead
// connection either.
func DefaultClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   30 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}
}

// fetcher downloads the parts of a manifest.
type fetcher struct {
	opts Options
	log  func(format string, args ...any)
	// progressMu serializes the progress callback. A parallel download
	// reports from several goroutines at once, and callers are free to keep
	// their state in a map — two concurrent writes to the same map crash
	// the whole process, so the callback must never run in parallel.
	progressMu sync.Mutex
}

// report publishes one progress tick. The call happens under a lock, so a
// caller may read and write its own state inside the callback without
// synchronising it.
func (f *fetcher) report(progress Progress) {
	if f.opts.Progress == nil {
		return
	}
	f.progressMu.Lock()
	defer f.progressMu.Unlock()
	f.opts.Progress(progress)
}

// fetch downloads one part to dest. It tries every mirror in order and
// verifies the result against expected (when expected is set).
func (f *fetcher) fetch(part Part, dest, expected string) error {
	var lastErr error
	for _, url := range part.URLs {
		for attempt := 0; attempt < f.opts.Attempts; attempt++ {
			err := f.download(url, part, dest)
			if err == nil {
				if expected == "" {
					return nil
				}
				sum, sumErr := fileSHA256(dest)
				if sumErr != nil {
					return sumErr
				}
				if strings.EqualFold(sum, expected) {
					return nil
				}
				// The mirror serves the wrong bytes — the file is useless,
				// no matter how often it is asked again.
				_ = os.Remove(dest)
				lastErr = fmt.Errorf("%w: %s does not match the expected checksum", ErrChecksumMismatch, url)
				f.log("bootstrap: %v", lastErr)
				break
			}
			lastErr = err
			if errors.Is(err, errNotFound) {
				f.log("bootstrap: %s has no copy of %s", url, part.ID)
				break
			}
			f.log("bootstrap: %s failed: %v", url, err)
			if attempt+1 < f.opts.Attempts {
				time.Sleep(f.backoff(attempt))
			}
		}
	}
	if lastErr == nil {
		lastErr = errors.New("bootstrap: no mirror served the file")
	}
	return lastErr
}

// backoff is the pause before the next attempt on the same mirror.
func (f *fetcher) backoff(attempt int) time.Duration {
	if attempt < len(f.opts.Backoff) {
		return f.opts.Backoff[attempt]
	}
	return f.opts.Backoff[len(f.opts.Backoff)-1]
}

// download fetches url into dest, resuming a partial file when the server
// supports range requests.
//
// A single connection saturates the origin's per-connection limit, so a big
// archive crawls at whatever one stream delivers. When the part asks for
// several connections the file is split into byte ranges that are fetched
// concurrently; the chunks land in separate part files and are concatenated
// afterwards. The result is byte-identical to the single-connection path —
// the checksum still decides whether it is acceptable.
func (f *fetcher) download(url string, part Part, dest string) error {
	connections := part.Connections
	if connections <= 1 {
		return f.downloadSingle(url, part, dest)
	}
	// A part without a declared size cannot be split into ranges.
	if part.Size <= 0 {
		f.log("bootstrap: part %q has no size, downloading on a single connection", part.ID)
		return f.downloadSingle(url, part, dest)
	}
	err := f.downloadParallel(url, part, dest, connections)
	if err == nil {
		return nil
	}
	// The parallel path needs a server that honours Range requests. If it
	// does not, fall back to the plain download instead of failing.
	if errors.Is(err, errNoRangeSupport) {
		f.log("bootstrap: %s does not support range requests, falling back to one connection", url)
		return f.downloadSingle(url, part, dest)
	}
	return err
}

// errNoRangeSupport marks a mirror that cannot serve byte ranges.
var errNoRangeSupport = errors.New("runtime download: the server does not support range requests")

// downloadSingle fetches the whole file on one connection, resuming a
// partial file when the server supports range requests.
func (f *fetcher) downloadSingle(url string, part Part, dest string) error {
	offset := int64(0)
	if info, err := os.Stat(dest); err == nil {
		offset = info.Size()
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := f.opts.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		// The server ignored the range request — start over.
		offset = 0
	case http.StatusPartialContent:
		start, err := rangeStart(resp.Header.Get("Content-Range"))
		if err != nil {
			return err
		}
		if start != offset {
			return fmt.Errorf("runtime download: server resumed at %d, expected %d", start, offset)
		}
	case http.StatusRequestedRangeNotSatisfiable:
		// The file is already complete.
		return nil
	case http.StatusNotFound, http.StatusGone:
		return errNotFound
	default:
		return fmt.Errorf("runtime download failed: HTTP %d", resp.StatusCode)
	}

	flags := os.O_CREATE | os.O_WRONLY
	if offset > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	out, err := os.OpenFile(dest, flags, 0o644)
	if err != nil {
		return err
	}

	total := part.Size
	if total <= 0 {
		total = responseTotal(resp, offset)
	}
	writer := &progressWriter{
		out:     out,
		f:        f,
		part:     part,
		total:    total,
		written:  offset,
	}
	buf := make([]byte, 1<<20)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := writer.Write(buf[:n]); writeErr != nil {
				out.Close()
				return writeErr
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			out.Close()
			return readErr
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	if part.Size > 0 {
		info, statErr := os.Stat(dest)
		if statErr != nil {
			return statErr
		}
		if info.Size() != part.Size {
			// The mirror served the wrong file — drop it, the next attempt
			// must not continue a file that can never be right.
			_ = os.Remove(dest)
			return fmt.Errorf("runtime download: expected %d bytes, got %d", part.Size, info.Size())
		}
	}
	return nil
}

// chunk is one byte range of a part, downloaded by a single connection.
type chunk struct {
	index int
	start int64
	end   int64 // inclusive
	path  string
}

// chunkTracker keeps the byte counters of the parallel chunks of one part.
//
// The chunks run concurrently, so their counters are guarded by a mutex. The
// tracker reports the total number of bytes of the part that are available,
// which is what the progress callback needs: the single-connection path
// reports the bytes of the whole file, and a parallel run must not look like
// it jumped to the end because the last range finished first.
type chunkTracker struct {
	mu       sync.Mutex
	perChunk map[int]int64
	base     int64
	size     int64
	last     int
}

// newChunkTracker returns a tracker for the given chunks. base is the number
// of bytes of the part that were already on disk when the attempt started.
func newChunkTracker(chunks []chunk, base int64, size int64) *chunkTracker {
	return &chunkTracker{
		perChunk: make(map[int]int64, len(chunks)),
		base:     base,
		size:     size,
	}
}

// add records the bytes a chunk delivered and returns the total number of
// bytes of the part that are now available.
func (t *chunkTracker) add(index int, written int64) int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.perChunk[index] = written
	done := t.base
	for _, value := range t.perChunk {
		done += value
	}
	return done
}

// publish reports the progress of the part. The last percentage is kept so
// the caller is not woken up for every single percent of a large archive.
func (t *chunkTracker) publish(part Part, done int64, report func(Progress)) {
	if report == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.size <= 0 {
		return
	}
	percent := int(done * 100 / t.size)
	if percent > 100 {
		percent = 100
	}
	if percent == t.last {
		return
	}
	t.last = percent
	report(Progress{PartID: part.ID, Received: done, Total: t.size})
}

// downloadParallel splits the part into `connections` byte ranges and
// fetches them at the same time.
//
// Each range is written to its own file next to the destination. The files
// are concatenated once every range arrived, so the destination only ever
// holds a complete archive — a crash mid-download never leaves a truncated
// file that a later run would mistake for a resumable one.
//
// The ranges are spread over the part's mirrors: two mirrors of the same
// host are often two different machines, and one machine caps a single
// connection at a few hundred KB/s. Giving every range its own mirror is
// what turns that cap into usable bandwidth.
func (f *fetcher) downloadParallel(url string, part Part, dest string, connections int) error {
	chunks := planChunks(part.Size, connections)
	chunkDir := dest + ".parts"
	if err := os.MkdirAll(chunkDir, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(chunkDir)

	// A stale chunk from an earlier attempt must not be reused blindly: the
	// file may have changed size since. Drop the directory content first.
	if err := clearDir(chunkDir); err != nil {
		return err
	}

	tracker := newChunkTracker(chunks, 0, part.Size)

	var (
		wg       sync.WaitGroup
		errMu    sync.Mutex
		firstErr error
	)
	for i := range chunks {
		// The path must be written back into the slice: the concatenation
		// step reads it from there.
		chunks[i].path = filepath.Join(chunkDir, fmt.Sprintf("%04d.part", chunks[i].index))
		c := chunks[i]
		// Round-robin the mirrors: range 0 takes the primary, range 1 the
		// first mirror, and so on.
		mirror := url
		if len(part.URLs) > 0 {
			mirror = part.URLs[c.index%len(part.URLs)]
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f.downloadRange(mirror, part, c, tracker); err != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				errMu.Unlock()
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}

	return concatChunks(chunks, dest)
}

// planChunks divides size into at most `connections` ranges of roughly equal
// length. The last chunk absorbs the remainder.
func planChunks(size int64, connections int) []chunk {
	if connections < 1 {
		connections = 1
	}
	if size <= 0 {
		return nil
	}
	// Very small files are not worth splitting — the request overhead would
	// cost more than the parallelism gains.
	const minChunkSize = 1 << 20
	if size < int64(connections)*minChunkSize {
		connections = int(size / minChunkSize)
		if connections < 1 {
			connections = 1
		}
	}
	chunkSize := size / int64(connections)
	chunks := make([]chunk, 0, connections)
	for i := 0; i < connections; i++ {
		start := int64(i) * chunkSize
		end := start + chunkSize - 1
		if i == connections-1 {
			end = size - 1
		}
		chunks = append(chunks, chunk{index: i, start: start, end: end})
	}
	return chunks
}

// downloadRange fetches one byte range into the chunk's own file.
func (f *fetcher) downloadRange(url string, part Part, c chunk, tracker *chunkTracker) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", c.start, c.end))
	resp, err := f.opts.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusPartialContent:
		// The only acceptable answer for a ranged request.
	case http.StatusOK:
		// The server ignored the Range header and sent the whole file. The
		// single-connection path can still handle that.
		return errNoRangeSupport
	case http.StatusRequestedRangeNotSatisfiable:
		return fmt.Errorf("runtime download: the server refused the range %d-%d", c.start, c.end)
	case http.StatusNotFound, http.StatusGone:
		return errNotFound
	default:
		return fmt.Errorf("runtime download failed: HTTP %d", resp.StatusCode)
	}

	start, err := rangeStart(resp.Header.Get("Content-Range"))
	if err != nil {
		return err
	}
	if start != c.start {
		return fmt.Errorf("runtime download: the server started at %d, expected %d", start, c.start)
	}

	out, err := os.OpenFile(c.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()

	written := int64(0)
	expected := c.end - c.start + 1
	buf := make([]byte, 1<<20)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			written += int64(n)
			// The tracker sums the bytes of every chunk, so the reported
			// figure grows with the part as a whole instead of jumping to
			// the end of the range that happens to finish first.
			done := tracker.add(c.index, written)
			// The parallel path writes its own chunk files, so the size cap
			// that guards the single-connection path has to be enforced
			// here as well — otherwise a wrong URL could fill the disk.
			if f.opts.MaxBytes > 0 && done > f.opts.MaxBytes {
				return fmt.Errorf("runtime download exceeded %d bytes", f.opts.MaxBytes)
			}
			tracker.publish(part, done, f.report)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if written != expected {
		return fmt.Errorf("runtime download: the range %d-%d delivered %d bytes, expected %d", c.start, c.end, written, expected)
	}
	return nil
}

// concatChunks joins the downloaded ranges into the destination file.
func concatChunks(chunks []chunk, dest string) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	for _, c := range chunks {
		in, err := os.Open(c.path)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			in.Close()
			return err
		}
		in.Close()
	}
	return out.Close()
}

// clearDir removes every file in a directory but keeps the directory itself.
func clearDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

// progressWriter forwards the download to the file while reporting progress
// and enforcing the size cap.
type progressWriter struct {
	out      io.Writer
	f        *fetcher
	part     Part
	total    int64
	written  int64
	last     int
	lastStep int64
}

// Write stores the bytes and reports the progress.
func (p *progressWriter) Write(b []byte) (int, error) {
	if p.f.opts.MaxBytes > 0 && p.written+int64(len(b)) > p.f.opts.MaxBytes {
		return 0, fmt.Errorf("runtime download exceeded %d bytes", p.f.opts.MaxBytes)
	}
	n, err := p.out.Write(b)
	p.written += int64(n)
	if p.f.opts.Progress != nil {
		progress := Progress{PartID: p.part.ID, Received: p.written, Total: p.total}
		if p.total > 0 {
			if percent := progress.Percent(); percent != p.last {
				p.last = percent
				p.f.report(progress)
			}
		} else if p.written-p.lastStep >= 4<<20 {
			// The server did not say how big the file is — report every few
			// megabytes instead of every percent.
			p.lastStep = p.written
			p.f.report(progress)
		}
	}
	return n, err
}

// rangeStart reads the first offset out of a Content-Range header.
func rangeStart(header string) (int64, error) {
	if header == "" {
		return 0, errors.New("runtime download: the server sent no content range")
	}
	value := strings.TrimPrefix(header, "bytes ")
	if idx := strings.Index(value, "-"); idx >= 0 {
		value = value[:idx]
	}
	start, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("runtime download: unreadable content range %q", header)
	}
	return start, nil
}

// responseTotal is the size of the whole file, as far as the server says.
func responseTotal(resp *http.Response, offset int64) int64 {
	if header := resp.Header.Get("Content-Range"); header != "" {
		if idx := strings.LastIndex(header, "/"); idx >= 0 {
			if total, err := strconv.ParseInt(strings.TrimSpace(header[idx+1:]), 10, 64); err == nil {
				return total
			}
		}
	}
	if resp.ContentLength > 0 {
		return offset + resp.ContentLength
	}
	return 0
}

// fileSHA256 is the checksum of a file on disk.
func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// fileExists reports whether path is a regular file.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
