/**
 * Import queue helpers for the product-library wizard.
 *
 * Separate from `Chat/utils/droppedFiles.ts`: that one only returns `File[]`
 * and is shared with chat, while this queue must keep each file's relative
 * path so the directory structure reaches the backend.
 */

import type { ImportEntry } from "../../api/modules/productLibrary";

export type { ImportEntry };

/** Largest number of files one import may queue. */
export const MAX_IMPORT_FILES = 500;

/**
 * Normalise a client path: backslashes to `/`, drop a leading `/` or `./`,
 * collapse repeated separators and strip traversal segments.
 */
export function normaliseRelativePath(raw: string): string {
  const parts = (raw || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/");
}

function entryKey(path: string, file: File): string {
  const size = typeof file.size === "number" ? file.size : 0;
  const stamp = typeof file.lastModified === "number" ? file.lastModified : 0;
  return `${path}::${size}::${stamp}`;
}

function toEntry(file: File, rawPath: string): ImportEntry {
  const path = normaliseRelativePath(rawPath) || file.name;
  return { file, path, key: entryKey(path, file) };
}

/** Build entries from an `<input type="file">` selection. */
export function entriesFromFileList(files: FileList | File[]): ImportEntry[] {
  return Array.from(files).map((file) => {
    // `webkitRelativePath` is filled by the browser for `webkitdirectory`
    // picks; a plain file pick leaves it empty, so fall back to the name.
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    return toEntry(file, relative || file.name);
  });
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      // `readEntries` returns at most ~100 entries per call; keep reading
      // until it yields an empty batch or large folders would be truncated.
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function collectEntry(
  entry: FileSystemEntry,
  out: ImportEntry[],
  max: number,
): Promise<boolean> {
  if (out.length >= max) return true;
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    // The File from `FileSystemFileEntry.file()` carries no
    // `webkitRelativePath`, so the entry's fullPath is the only path source.
    out.push(toEntry(file, entry.fullPath));
    return false;
  }
  if (!entry.isDirectory) return false;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children = await readAllDirectoryEntries(reader);
  for (const child of children) {
    if (await collectEntry(child, out, max)) return true;
  }
  return false;
}

/**
 * Collect files and folders from a drop, preserving their relative paths.
 *
 * `webkitGetAsEntry` must be called synchronously while the drop event is
 * still current, so callers snapshot the items before awaiting.
 */
export async function entriesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): Promise<{ entries: ImportEntry[]; truncated: boolean }> {
  const entries: ImportEntry[] = [];
  if (!dataTransfer) return { entries, truncated: false };

  const roots: FileSystemEntry[] = [];
  const plainFiles: File[] = [];
  const items = Array.from(dataTransfer.items ?? []);
  for (const item of items) {
    if (item.kind !== "file") continue;
    const getter = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => FileSystemEntry | null;
      }
    ).webkitGetAsEntry;
    const entry = typeof getter === "function" ? getter.call(item) : null;
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) plainFiles.push(file);
    }
  }

  let truncated = false;
  for (const entry of roots) {
    if (await collectEntry(entry, entries, MAX_IMPORT_FILES)) {
      truncated = true;
      break;
    }
  }
  for (const file of plainFiles) {
    if (entries.length >= MAX_IMPORT_FILES) {
      truncated = true;
      break;
    }
    entries.push(toEntry(file, file.name));
  }
  return { entries, truncated };
}

/** Merge two queues by key, keeping the incoming order and dropping repeats. */
export function mergeEntries(
  current: ImportEntry[],
  incoming: ImportEntry[],
): ImportEntry[] {
  const seen = new Set(current.map((entry) => entry.key));
  const merged = [...current];
  for (const entry of incoming) {
    if (seen.has(entry.key)) continue;
    if (merged.length >= MAX_IMPORT_FILES) break;
    seen.add(entry.key);
    merged.push(entry);
  }
  return merged;
}
