#!/usr/bin/env node
/**
 * Pre-seed Remotion's headless-shell cache so `ensureBrowser()` does not
 * download it again.
 *
 * The upstream CDN (storage.googleapis.com) is slow on this network — the
 * pinned ~126 MB archive takes ~20 minutes at ~170 KB/s. The npmmirror copy
 * of the same archive is ~90x faster. This script takes a locally downloaded
 * archive, unpacks it into the layout Remotion expects and writes the VERSION
 * marker, so the build script's `ensureBrowser()` call finds a complete,
 * version-matching install and returns immediately.
 *
 * Usage:
 *   node prepare-headless-shell.mjs --runtime <staged runtime dir> \
 *        [--archive <chrome-headless-shell-win64.zip>]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const TESTED_VERSION = "157.0.8080.0";
const ARCHIVE_NAME = "chrome-headless-shell-win64.zip";

function parseArgs(argv) {
  const result = { runtime: null, archive: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--runtime") result.runtime = argv[++i];
    else if (argv[i] === "--archive") result.archive = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!result.runtime) {
    throw new Error(
      "usage: node prepare-headless-shell.mjs --runtime <staged runtime dir> [--archive <zip>]",
    );
  }
  return result;
}

function main() {
  const { runtime } = parseArgs(process.argv.slice(2));
  const downloadsFolder = path.join(
    runtime,
    "node_modules",
    ".remotion",
    "chrome-headless-shell",
  );
  // Remotion resolves the browser as <downloads>/<platform>/<archive dir>,
  // i.e. chrome-headless-shell/win64/chrome-headless-shell-win64/. The
  // layout matters: the renderer looks the executable up by that path.
  const platformFolder = path.join(downloadsFolder, "win64");
  const outputPath = path.join(platformFolder, "chrome-headless-shell-win64");
  const versionFile = path.join(downloadsFolder, "VERSION");

  // The archive is normally left in the downloads folder by a previous run.
  const archive =
    process.argv.includes("--archive")
      ? process.argv[process.argv.indexOf("--archive") + 1]
      : path.join(downloadsFolder, ARCHIVE_NAME);
  if (!fs.existsSync(archive)) {
    throw new Error(`the archive is missing: ${archive}`);
  }

  fs.mkdirSync(downloadsFolder, { recursive: true });
  // A partial directory would make Remotion skip the download and then fail
  // at render time, so start from a clean slate.
  fs.rmSync(outputPath, { recursive: true, force: true });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "octop-headless-shell-"));
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${scratch.replaceAll("'", "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
    // The archive holds chrome-headless-shell-win64/… — that is exactly the
    // directory Remotion expects below the platform folder.
    const extracted = path.join(scratch, "chrome-headless-shell-win64");
    if (!fs.existsSync(extracted)) {
      throw new Error(
        `the archive does not contain chrome-headless-shell-win64: ${scratch}`,
      );
    }
    fs.rmSync(platformFolder, { recursive: true, force: true });
    fs.mkdirSync(platformFolder, { recursive: true });
    fs.cpSync(extracted, outputPath, { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(versionFile, TESTED_VERSION);
    console.log(
      `Pre-seeded the headless shell ${TESTED_VERSION} under ${outputPath}`,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
