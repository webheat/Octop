#!/usr/bin/env node
/** Build-time only: stage a pinned Node runtime and locked Remotion dependencies. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const NODE_VERSION = "24.14.0";

function parseArgs(argv) {
  const result = { output: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--output") result.output = argv[++i];
    else if (argv[i] === "--target") result.target = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!result.output || !["win-x64", "win-arm64"].includes(result.target)) {
    throw new Error("usage: node build-desktop-runtime.mjs --target win-x64|win-arm64 --output <directory>");
  }
  return result;
}

function download(url, destination) {
  execFileSync("curl.exe", ["--fail", "--location", "--silent", "--show-error", "--retry", "4", "--retry-all-errors", "--retry-delay", "2", "--max-time", "180", "--output", destination, url], { stdio: "inherit" });
}

// Moves a prepared directory into place.
//
// rename() is atomic and cheap on one volume, but Windows temp usually lives on
// C: while the checkout can live on D:, and rename() across volumes fails with
// EXDEV. Fall back to copy-then-delete so the build works on either layout.
function moveDirectory(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

async function main() {
  const { output, target } = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("Windows runtime must be built on a Windows host");
  const root = path.resolve(output);
  const expectedRoot = path.resolve(SOURCE, "../desktop/src/video-runtime");
  if (root !== expectedRoot || path.basename(root) !== "video-runtime") {
    throw new Error(`runtime output must be the dedicated build directory: ${expectedRoot}`);
  }
  let replaceExisting = false;
  if (fs.existsSync(root)) {
    const existing = path.join(root, "runtime.json");
    if (fs.existsSync(existing)) {
      const metadata = JSON.parse(fs.readFileSync(existing, "utf8"));
      if (metadata.schema !== "octop-desktop-video-runtime/1" || metadata.templateVersion !== 1) {
        throw new Error(`refusing to replace unowned runtime: ${root}`);
      }
      replaceExisting = true;
    } else if (fs.readdirSync(root).length > 0) {
      throw new Error(`refusing to replace unowned directory: ${root}`);
    } else {
      replaceExisting = true;
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "octop-video-runtime-"));
  const stagedRuntime = path.join(scratch, "runtime");
  fs.mkdirSync(stagedRuntime);
  try {
    const nodeDir = `node-v${NODE_VERSION}-${target}`;
    const cacheDir = path.join(os.tmpdir(), "octop-video-runtime-cache-v1");
    fs.mkdirSync(cacheDir, { recursive: true });
    const archive = path.join(cacheDir, `${nodeDir}.zip`);
    const temporaryArchive = path.join(scratch, "node.zip");
    const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`;
    if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) {
      download(`${baseUrl}/${nodeDir}.zip`, temporaryArchive);
      fs.renameSync(temporaryArchive, archive);
    }
    download(`${baseUrl}/SHASUMS256.txt`, path.join(scratch, "SHASUMS256.txt"));
    const sums = fs.readFileSync(path.join(scratch, "SHASUMS256.txt"), "utf8");
    const expected = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${nodeDir}.zip`))?.split(/\s+/)[0];
    const actual = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (!expected || actual !== expected) throw new Error("downloaded Node archive failed SHA-256 verification");
    const quote = (value) => value.replaceAll("'", "''");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(scratch)}' -Force`], { stdio: "inherit" });
    fs.copyFileSync(path.join(scratch, nodeDir, "node.exe"), path.join(stagedRuntime, "node.exe"));
    fs.copyFileSync(path.join(scratch, nodeDir, "LICENSE"), path.join(stagedRuntime, "NODE-LICENSE.txt"));

    for (const entry of ["desktop-worker.mjs", "render.mjs", "project.mjs", "src", "package.json", "package-lock.json"]) {
      fs.cpSync(path.join(SOURCE, entry), path.join(stagedRuntime, entry), { recursive: true });
    }
    execFileSync(path.join(scratch, nodeDir, "node.exe"), [
      path.join(scratch, nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      "ci", "--omit=dev", "--no-audit", "--no-fund",
    ], { cwd: stagedRuntime, stdio: "inherit" });
    if (target !== "win-x64") throw new Error("The bundled Remotion headless shell currently supports Windows x64 only");
    const browserPrep = path.join(stagedRuntime, "prepare-browser.mjs");
    fs.writeFileSync(browserPrep, [
      'import { ensureBrowser } from "@remotion/renderer";',
      'const result = await ensureBrowser({ chromeMode: "headless-shell" });',
      'if (result.type === "no-browser" || !result.path) throw new Error("Remotion headless shell was not installed");',
      'console.log(`Prepared pinned headless shell: ${result.path}`);',
    ].join("\n"));
    try {
      execFileSync(path.join(scratch, nodeDir, "node.exe"), [browserPrep], { cwd: stagedRuntime, stdio: "inherit" });
    } finally {
      fs.rmSync(browserPrep, { force: true });
    }
    fs.writeFileSync(path.join(stagedRuntime, "runtime.json"), `${JSON.stringify({ schema: "octop-desktop-video-runtime/1", templateVersion: 1, outputBatchVersion: 1, nodeVersion: NODE_VERSION, target, browserMode: "headless-shell" }, null, 2)}\n`);
    if (replaceExisting) fs.rmSync(root, { recursive: true, force: true });
    moveDirectory(stagedRuntime, root);
    console.log(`Prepared trusted video runtime at ${root}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
