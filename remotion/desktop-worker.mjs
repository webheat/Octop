#!/usr/bin/env node
/** Trusted desktop worker. Project data is validated and never imported/executed. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validatePackage } from "./project.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SCHEMA = "octop-desktop-video-runtime/1";
const NODE_EXECUTABLE = process.platform === "win32" ? "node.exe" : "node";
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// Diagnostics go to stderr on purpose: stdout carries the JSONL protocol the
// desktop shell parses, while stderr is captured verbatim into the shell's
// log file. That is what lets a support report say *why* a check failed
// instead of only that it did.
const debug = (message) => process.stderr.write(`[worker] ${message}\n`);

function parseArgs(argv) {
  const result = { mode: null, cache: process.env.OCTOP_DESKTOP_VIDEO_CACHE ?? null, project: null, out: null, targets: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--check", "--verify"].includes(arg)) {
      if (result.mode) throw new Error("only one environment action can be selected");
      result.mode = arg.slice(2);
    } else if (arg === "--cache") result.cache = argv[++i];
    else if (arg === "--project") result.project = argv[++i];
    else if (arg === "--out") result.out = argv[++i];
    else if (arg === "--targets") {
      try { result.targets = JSON.parse(argv[++i]); } catch { throw new Error("invalid render targets"); }
    }
    else throw new Error("invalid worker arguments");
  }
  if (result.mode && (!result.cache || result.project || result.out)) throw new Error("environment action requires only --cache");
  if (!result.mode && (!result.project || !result.out)) throw new Error("--project and --out are required");
  if (result.targets !== null && (!Array.isArray(result.targets) || result.targets.length < 1 || result.targets.length > 32)) throw new Error("invalid render targets");
  return result;
}

function runtimeDirectory() {
  return process.env.OCTOP_DESKTOP_VIDEO_RUNTIME ? path.resolve(process.env.OCTOP_DESKTOP_VIDEO_RUNTIME) : ROOT;
}

function readRuntime(dir) {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8"));
    if (runtime.schema !== RUNTIME_SCHEMA || runtime.templateVersion !== 1 || !fs.statSync(path.join(dir, NODE_EXECUTABLE)).isFile()) return null;
    return runtime;
  } catch {
    return null;
  }
}

function cacheDirectory(value) {
  const cache = path.resolve(value);
  fs.mkdirSync(cache, { recursive: true });
  const probe = path.join(cache, `.octop-write-${randomUUID()}`);
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe);
  return cache;
}

function sourceFingerprint(runtimeDir, browserPath) {
  const hash = createHash("sha256");
  const files = ["runtime.json", "package.json", "package-lock.json", "desktop-worker.mjs", "render.mjs", "project.mjs"];
  const addTree = (relative) => {
    const full = path.join(runtimeDir, relative);
    // A missing tree means the runtime is incomplete. Returning null keeps
    // the check reporting "not verified" instead of crashing the worker with
    // an ENOENT stack trace.
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) addTree(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  addTree("src");
  for (const relative of files) {
    const file = path.join(runtimeDir, relative);
    if (!fs.existsSync(file)) return null;
    hash.update(relative).update(fs.readFileSync(file));
  }
  const stat = fs.statSync(browserPath);
  const nodeStat = fs.statSync(path.join(runtimeDir, NODE_EXECUTABLE));
  hash.update(path.resolve(browserPath)).update(String(stat.size)).update(String(stat.mtimeMs));
  hash.update(String(nodeStat.size)).update(String(nodeStat.mtimeMs));
  return hash.digest("hex");
}

async function prerequisites(cache) {
  const dir = runtimeDirectory();
  const runtime = readRuntime(dir);
  if (!runtime) {
    debug(`runtime manifest missing or invalid under ${dir}`);
    return { errorCode: "RUNTIME_MISSING", requiresInstall: true };
  }
  try {
    await import("@remotion/bundler");
    await import("@remotion/renderer");
  } catch (error) {
    debug(`the Remotion packages could not be imported: ${error?.code ?? error?.message ?? error}`);
    return { errorCode: "RUNTIME_MISSING", requiresInstall: true };
  }
  const { detectBrowser } = await import("./render.mjs");
  const browserPath = detectBrowser();
  if (!browserPath) {
    debug(`no usable Chromium was found (runtime dir ${dir})`);
    return { errorCode: "BROWSER_MISSING", requiresInstall: true };
  }
  // A fingerprint that cannot be computed means the runtime tree is
  // incomplete (missing sources). The tree is then treated as unverified
  // rather than as a missing component: the sources are present on a real
  // installation, and reporting "install again" for a partial tree would
  // send the user into a reinstall loop.
  const fingerprint = sourceFingerprint(dir, browserPath);
  debug(`runtime ok: dir=${dir} browser=${browserPath} fingerprint=${fingerprint ? "computed" : "unavailable"}`);
  return { dir, runtime, browserPath, fingerprint, cache };
}

function environment(status, stage = null, progress = null) {
  emit({ type: "environment", state: status.state, stage, progress, ...(status.errorCode ? { errorCode: status.errorCode } : {}), ...(status.requiresInstall ? { requiresInstall: true } : {}), checkedAt: Math.floor(Date.now() / 1000) });
}

function watchCancellation() {
  const controller = new AbortController();
  const onInput = (chunk) => { if (String(chunk).split(/\r?\n/).includes("cancel")) controller.abort(); };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onInput);
  process.stdin.resume();
  return {
    signal: controller.signal,
    close() { process.stdin.removeListener("data", onInput); process.stdin.pause(); },
  };
}

async function checkEnvironment(cacheArg) {
  environment({ state: "checking" }, "components");
  let cache;
  try { cache = cacheDirectory(cacheArg); }
  catch (error) {
    const errorCode = error?.code === "ENOSPC" ? "ENV_DISK_FULL" : "ENV_CHECK_FAILED";
    environment({ state: "failed", errorCode });
    return 1;
  }
  const ready = await prerequisites(cache);
  if (ready.errorCode) {
    environment({ state: "needs_setup", errorCode: ready.errorCode, requiresInstall: ready.requiresInstall }, ready.errorCode === "BROWSER_MISSING" ? "browser" : "components");
    return 0;
  }
  const stampPath = path.join(cache, "ready.json");
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(stampPath, "utf8")); } catch { /* No successful local render yet. */ }
  if (stamp?.schema === "octop-desktop-video-ready/1" && stamp.fingerprint === ready.fingerprint) {
    environment({ state: "ready" });
  } else {
    // The components are in place but no successful local render has been
    // recorded for this exact build. That is a *verification* gap, not a
    // missing component: reporting it as "needs_setup" without an error code
    // made the UI show "需要安装" forever, even right after a successful
    // install. requiresInstall=false tells the UI to offer verification
    // instead of another download.
    environment({ state: "needs_setup", errorCode: "ENV_NOT_VERIFIED", requiresInstall: false });
  }
  return 0;
}

async function verifyEnvironment(cacheArg) {
  environment({ state: "verifying" }, "components");
  let cache;
  try { cache = cacheDirectory(cacheArg); }
  catch (error) {
    environment({ state: "failed", errorCode: error?.code === "ENOSPC" ? "ENV_DISK_FULL" : "ENV_CHECK_FAILED" });
    return 1;
  }
  const ready = await prerequisites(cache);
  if (ready.errorCode) {
    environment({ state: "needs_setup", errorCode: ready.errorCode, requiresInstall: ready.requiresInstall }, ready.errorCode === "BROWSER_MISSING" ? "browser" : "components");
    return 0;
  }
  const cancellation = watchCancellation();
  const verificationDir = fs.mkdtempSync(path.join(cache, "verify-"));
  try {
    if (cancellation.signal.aborted) throw Object.assign(new Error("verification cancelled"), { name: "AbortError" });
    environment({ state: "verifying" }, "browser");
    process.chdir(cache);
    const fixture = path.join(verificationDir, "project");
    fs.mkdirSync(path.join(fixture, "assets"), { recursive: true });
    const scriptBytes = Buffer.from(JSON.stringify({ fps: 1, width: 640, height: 360, scenes: [{ type: "title", duration: 1, text: "Octop environment check" }] }));
    fs.writeFileSync(path.join(fixture, "script.json"), scriptBytes);
    fs.writeFileSync(path.join(fixture, "manifest.json"), JSON.stringify({
      schema: "octop-remotion-package/1", template_version: "1", project_id: "environment-check",
      script_sha256: createHash("sha256").update(scriptBytes).digest("hex"), assets: [],
    }));
    validatePackage(fixture);
    environment({ state: "verifying" }, "render_test", 0);
    const log = console.log;
    console.log = (...values) => process.stderr.write(`${values.join(" ")}\n`);
    try {
      const { renderProject } = await import("./render.mjs");
      const output = path.join(verificationDir, "verification.mp4");
      await renderProject({
        projectDir: fixture,
        outPath: output,
        trustedTemplate: true,
        browserExecutable: ready.browserPath,
        cancelSignal: cancellation.signal,
        onProgress: ({ stage, progress }) => {
          if (stage === "rendering") environment({ state: "verifying" }, "render_test", Math.max(0, Math.min(1, progress)));
        },
      });
      const bytes = fs.readFileSync(output);
      if (bytes.length <= 16 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("verification output is not a valid MP4");
      const finalFingerprint = sourceFingerprint(ready.dir, ready.browserPath);
      const stamp = { schema: "octop-desktop-video-ready/1", fingerprint: finalFingerprint, checkedAt: Math.floor(Date.now() / 1000) };
      const tempStamp = path.join(cache, `.ready-${randomUUID()}`);
      fs.writeFileSync(tempStamp, JSON.stringify(stamp));
      fs.renameSync(tempStamp, path.join(cache, "ready.json"));
    } finally {
      console.log = log;
    }
    environment({ state: "ready" });
    return 0;
  } catch (error) {
    const errorCode = error?.name === "AbortError" ? "ENV_CHECK_FAILED" : error?.code === "ENOSPC" ? "ENV_DISK_FULL" : /browser|chrom(e|ium)/i.test(error?.message ?? "") ? "ENV_BROWSER_FAILED" : "ENV_RENDER_FAILED";
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    environment({ state: "failed", errorCode }, errorCode === "ENV_BROWSER_FAILED" ? "browser" : "render_test");
    return 1;
  } finally {
    cancellation.close();
    fs.rmSync(verificationDir, { recursive: true, force: true });
  }
}

export function validateTargets(targets) {
  if (!Array.isArray(targets)) return null;
  const ids = new Set();
  const filenames = new Set();
  return targets.map((target) => {
    if (!target || typeof target !== "object" || typeof target.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(target.id) || ids.has(target.id)) throw new Error("invalid render target id");
    ids.add(target.id);
    if (typeof target.filename !== "string" || path.basename(target.filename) !== target.filename || !/^[a-zA-Z0-9._-]{1,120}\.mp4$/i.test(target.filename)) throw new Error("invalid render target filename");
    const filenameKey = target.filename.toLowerCase();
    if (filenames.has(filenameKey)) throw new Error("duplicate render target filename");
    filenames.add(filenameKey);
    if (target.profile && !["short_vertical", "landscape", "square", "custom"].includes(target.profile)) throw new Error("invalid render profile");
    if (!Number.isInteger(target.width) || target.width < 2 || target.width > 4096 || target.width % 2) throw new Error("invalid render target width");
    if (!Number.isInteger(target.height) || target.height < 2 || target.height > 4096 || target.height % 2) throw new Error("invalid render target height");
    if (!Number.isInteger(target.fps) || target.fps < 1 || target.fps > 120) throw new Error("invalid render target fps");
    return target;
  });
}

async function renderJob(project, out, rawTargets = null) {
  const cache = cacheDirectory(process.env.OCTOP_DESKTOP_VIDEO_CACHE ?? path.join(process.cwd(), "desktop-video-environment"));
  const ready = await prerequisites(cache);
  if (ready.errorCode) {
    emit({ type: "error", code: ready.errorCode });
    process.exitCode = 1;
    return;
  }
  const cancellation = watchCancellation();
  try {
    if (cancellation.signal.aborted) throw Object.assign(new Error("render cancelled"), { name: "AbortError" });
    const data = validatePackage(project);
    process.chdir(cache);
    const log = console.log;
    console.log = (...values) => process.stderr.write(`${values.join(" ")}\n`);
    try {
      emit({ type: "stage", stage: "preparing" });
      const { renderProject } = await import("./render.mjs");
      const targets = validateTargets(rawTargets);
      if (!targets) {
        const result = await renderProject({ projectDir: data.root, outPath: path.resolve(out), trustedTemplate: true, browserExecutable: ready.browserPath, cancelSignal: cancellation.signal,
          onStage: (stage) => emit({ type: "stage", stage }),
          onProgress: ({ stage, progress }) => { if (stage === "rendering") emit({ type: "progress", progress: Math.max(0, Math.min(1, progress)) }); },
        });
        emit({ type: "stage", stage: "saving" });
        const stat = fs.statSync(result.output);
        if (!stat.isFile() || stat.size <= 0) throw new Error("renderer produced an empty output");
        emit({ type: "complete", output: result.output, bytes: stat.size, duration: result.duration });
      } else {
        const outputRoot = path.resolve(out);
        fs.mkdirSync(outputRoot, { recursive: true });
        const outputs = [];
        for (const target of targets) {
          if (cancellation.signal.aborted) throw Object.assign(new Error("render cancelled"), { name: "AbortError" });
          const destination = path.join(outputRoot, target.filename);
          emit({ type: "target-start", targetId: target.id });
          try {
            const result = await renderProject({ projectDir: data.root, outPath: destination, profile: target.profile === "custom" ? null : target.profile, width: target.width, height: target.height, fps: target.fps, trustedTemplate: true, browserExecutable: ready.browserPath, cancelSignal: cancellation.signal,
              onProgress: ({ stage, progress }) => { if (stage === "rendering") emit({ type: "progress", targetId: target.id, progress: Math.max(0, Math.min(1, progress)) }); },
            });
            const stat = fs.statSync(result.output);
            if (!stat.isFile() || stat.size <= 0) throw new Error("renderer produced an empty output");
            const item = { targetId: target.id, output: result.output, bytes: stat.size, duration: result.duration, width: target.width, height: target.height, fps: target.fps };
            outputs.push(item);
            emit({ type: "target-complete", ...item });
          } catch (error) {
            if (error?.name === "AbortError" || cancellation.signal.aborted) throw error;
            emit({ type: "target-failed", targetId: target.id, errorCode: error?.code ?? "RENDER_FAILED", message: error instanceof Error ? error.message : String(error) });
          }
        }
        const failed = targets.length - outputs.length;
        emit({ type: "batch-complete", succeeded: outputs.length, failed, outputs });
      }
    } finally { console.log = log; }
  } catch (error) {
    const cancelled = error?.name === "AbortError" || /cancel/i.test(error?.message ?? "");
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    emit({ type: "error", code: cancelled ? "CANCELLED" : error?.code === "PACKAGE_INVALID" ? "PACKAGE_INVALID" : "RENDER_FAILED" });
    process.exitCode = 1;
  } finally {
    cancellation.close();
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "check") process.exitCode = await checkEnvironment(args.cache);
    else if (args.mode === "verify") process.exitCode = await verifyEnvironment(args.cache);
    else await renderJob(args.project, args.out, args.targets);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    if (process.argv.includes("--check") || process.argv.includes("--verify")) {
      environment({ state: "failed", errorCode: "ENV_CHECK_FAILED" });
    } else {
      emit({ type: "error", code: "RENDER_FAILED" });
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
