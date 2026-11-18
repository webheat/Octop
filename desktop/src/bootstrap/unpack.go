package bootstrap

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Extract unpacks an archive into dest. The format is "zip" or "tar.gz"; an
// empty format is inferred from the file name. When stripRoot is set, the
// single top-level directory of the archive is dropped — that is how the
// portable runtime zip is shaped.
//
// The destination belongs to the archive: whatever was in it is removed
// first, so a part never mixes with the files of an older version.
func Extract(archive, dest, format string, stripRoot bool) error {
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return extractInto(archive, dest, format, stripRoot)
}

// ExtractOver unpacks an archive into dest without clearing it first. It is
// the append counterpart of Extract: several parts can layer files into one
// target (the portable runtime puts deps-core, app and optional shards under
// the same packages/ directory) when only the first one owns the directory.
func ExtractOver(archive, dest, format string, stripRoot bool) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return extractInto(archive, dest, format, stripRoot)
}

// extractInto unpacks archive into dest, optionally dropping the single
// top-level directory. The caller owns dest's lifecycle.
func extractInto(archive, dest, format string, stripRoot bool) error {
	switch strings.ToLower(format) {
	case "zip":
		return extractZip(archive, dest, stripRoot)
	case "tar.gz", "tgz":
		return extractTarGz(archive, dest, stripRoot)
	case "":
		name := strings.ToLower(archive)
		switch {
		case strings.HasSuffix(name, ".zip"):
			return extractZip(archive, dest, stripRoot)
		case strings.HasSuffix(name, ".tar.gz"), strings.HasSuffix(name, ".tgz"):
			return extractTarGz(archive, dest, stripRoot)
		}
		return fmt.Errorf("bootstrap: cannot tell the archive format of %s", archive)
	default:
		return fmt.Errorf("bootstrap: unsupported archive format %q", format)
	}
}

// extractZip unpacks a zip archive.
func extractZip(archive, dest string, stripRoot bool) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, entry := range reader.File {
		name := entry.Name
		if stripRoot {
			name = stripFirstComponent(name)
			if name == "" {
				continue
			}
		}
		target, err := targetPath(dest, name)
		if err != nil {
			return err
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			if err := extractSymlink(entry, target); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		err = writeFile(target, source, entry.Mode().Perm())
		source.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// extractTarGz unpacks a gzipped tar archive.
func extractTarGz(archive, dest string, stripRoot bool) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()

	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := header.Name
		if stripRoot {
			name = stripFirstComponent(name)
			if name == "" {
				continue
			}
		}
		target, err := targetPath(dest, name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if runtime.GOOS == "windows" {
				// Windows needs extra privileges to create a link.
				continue
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := writeFile(target, reader, os.FileMode(header.Mode).Perm()); err != nil {
				return err
			}
		}
	}
}

// extractSymlink recreates a symlink from a zip entry. Windows cannot do it
// without extra privileges, so the entry is skipped there.
func extractSymlink(entry *zip.File, target string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	source, err := entry.Open()
	if err != nil {
		return err
	}
	linkTarget, err := io.ReadAll(source)
	source.Close()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.Symlink(string(linkTarget), target)
}

// writeFile copies a stream into a file.
func writeFile(target string, source io.Reader, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o644
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, source)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	return err
}

// targetPath maps an archive entry onto a path under dest and rejects
// anything that would escape it.
func targetPath(dest, name string) (string, error) {
	rel := filepath.Clean(filepath.FromSlash(strings.ReplaceAll(name, "\\", "/")))
	if rel == "." || rel == "" {
		return "", fmt.Errorf("bootstrap: illegal path %q", name)
	}
	if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("bootstrap: illegal path %q", name)
	}
	target := filepath.Join(dest, rel)
	prefix := filepath.Clean(dest) + string(os.PathSeparator)
	if !strings.HasPrefix(target, prefix) {
		return "", fmt.Errorf("bootstrap: illegal path %q", name)
	}
	return target, nil
}

// stripFirstComponent drops the top-level directory of an archive entry.
func stripFirstComponent(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = strings.TrimPrefix(name, "./")
	idx := strings.Index(name, "/")
	if idx < 0 {
		return ""
	}
	return name[idx+1:]
}
