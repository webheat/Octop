import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_FILES,
  entriesFromDataTransfer,
  entriesFromFileList,
  mergeEntries,
  normaliseRelativePath,
} from "./importFiles";

function makeFile(name: string, body = "x"): File {
  return new File([body], name, { type: "image/jpeg" });
}

function withRelativePath(file: File, path: string): File {
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

function fakeFileEntry(path: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: path.split("/").pop() ?? path,
    fullPath: path,
    file: (resolve: (file: File) => void) =>
      resolve(makeFile(path.split("/").pop() ?? "f.jpg")),
  } as unknown as FileSystemEntry;
}

function fakeDirectoryEntry(
  path: string,
  children: FileSystemEntry[],
): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name: path.split("/").pop() ?? path,
    fullPath: path,
    createReader: () => {
      // The reader is stateful: first call returns the children, second an
      // empty batch. The real one paginates, so callers must loop until empty.
      let served = false;
      return {
        readEntries: (resolve: (batch: FileSystemEntry[]) => void) => {
          // Mark as served before resolving: a synchronous resolve would let
          // the caller re-enter readEntries while this flag is still false.
          const batch = served ? [] : children;
          served = true;
          resolve(batch);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function dataTransferWith(entries: FileSystemEntry[]): DataTransfer {
  return {
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
  } as unknown as DataTransfer;
}

describe("normaliseRelativePath", () => {
  it("normalises separators and drops traversal segments", () => {
    expect(normaliseRelativePath("bag\\front\\01.jpg")).toBe(
      "bag/front/01.jpg",
    );
    expect(normaliseRelativePath("/bag//01.jpg")).toBe("bag/01.jpg");
    expect(normaliseRelativePath("./bag/01.jpg")).toBe("bag/01.jpg");
    expect(normaliseRelativePath("../../etc/passwd")).toBe("etc/passwd");
    expect(normaliseRelativePath("")).toBe("");
  });
});

describe("entriesFromFileList", () => {
  it("keeps the plain filename when no directory was picked", () => {
    const [entry] = entriesFromFileList([makeFile("01.jpg")]);
    expect(entry.path).toBe("01.jpg");
  });

  it("keeps webkitRelativePath for directory picks", () => {
    const file = withRelativePath(
      makeFile("01.jpg"),
      "hiking-bag/front/01.jpg",
    );
    const [entry] = entriesFromFileList([file]);
    expect(entry.path).toBe("hiking-bag/front/01.jpg");
  });
});

describe("mergeEntries", () => {
  it("appends instead of replacing, and de-dupes by key", () => {
    const first = entriesFromFileList([makeFile("a.jpg")]);
    const second = entriesFromFileList([makeFile("b.jpg"), makeFile("a.jpg")]);
    const merged = mergeEntries(first, second);
    expect(merged.map((entry) => entry.path)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("never grows past the cap", () => {
    const many = Array.from({ length: MAX_IMPORT_FILES + 20 }, (_, index) =>
      makeFile(`${index}.jpg`, String(index)),
    );
    const merged = mergeEntries([], entriesFromFileList(many));
    expect(merged).toHaveLength(MAX_IMPORT_FILES);
  });
});

describe("entriesFromDataTransfer", () => {
  it("recursively expands folders and keeps the relative path", async () => {
    const transfer = dataTransferWith([
      fakeFileEntry("/loose.jpg"),
      fakeDirectoryEntry("/hiking-bag", [
        fakeFileEntry("/hiking-bag/01.jpg"),
        fakeDirectoryEntry("/hiking-bag/front", [
          fakeFileEntry("/hiking-bag/front/02.jpg"),
        ]),
      ]),
    ]);

    const { entries, truncated } = await entriesFromDataTransfer(transfer);
    expect(truncated).toBe(false);
    expect(entries.map((entry) => entry.path)).toEqual([
      "loose.jpg",
      "hiking-bag/01.jpg",
      "hiking-bag/front/02.jpg",
    ]);
  });

  it("returns nothing for a null DataTransfer", async () => {
    await expect(entriesFromDataTransfer(null)).resolves.toEqual({
      entries: [],
      truncated: false,
    });
  });
});
