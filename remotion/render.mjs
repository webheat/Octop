#!/usr/bin/env node
/**
 * Local renderer: script.json (+ assets) → mp4.
 *
 * Usage:
 *   node render.mjs --project <dir> [--out <file.mp4>] [--quality draft|prod]
 *
 * <dir> must contain:
 *   script.json      the script produced by the LLM
 *   assets/          images / base videos referenced by the script
 *
 * The Remotion project itself (this directory) provides the components; the
 * project folder only carries data, so a script produced on a remote server
 * can be rendered here without shipping any code.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadAudioPlan, mergeAudioPlan, validateScript } from "./project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = path.join(HERE, "src", "index.ts");
const LOCAL_NODE_MODULES = path.join(HERE, "node_modules");

/**
 * Find a Chromium to render with.
 *
 * Remotion downloads its own headless shell, but that download can be
 * unusably slow on some networks. A locally installed Chrome/Chromium
 * (Playwright's, or the system one) works just as well and is preferred.
 */
export function detectBrowser() {
  const explicit = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const bundled = path.join(HERE, "node_modules", ".remotion", "chrome-headless-shell", "win64", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  if (fs.existsSync(bundled)) return bundled;

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const pwRoot = path.join(localAppData, "ms-playwright");
    if (fs.existsSync(pwRoot)) {
      for (const dir of fs.readdirSync(pwRoot).sort().reverse()) {
        const exe = path.join(pwRoot, dir, "chrome-win64", "chrome.exe");
        if (fs.existsSync(exe)) return exe;
        const mac = path.join(pwRoot, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium");
        if (fs.existsSync(mac)) return mac;
        const linux = path.join(pwRoot, dir, "chrome-linux", "chrome");
        if (fs.existsSync(linux)) return linux;
      }
    }
    for (const candidate of [
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
    for (const candidate of [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = { project: null, out: null, quality: "prod", scale: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--project" || arg === "-p") args.project = next();
    else if (arg === "--out" || arg === "-o") args.out = next();
    else if (arg === "--quality" || arg === "-q") args.quality = next();
    else if (arg === "--scale") args.scale = Number(next());
  }
  return args;
}

export async function renderProject({ projectDir, outPath, quality = "prod", onProgress = () => {}, onStage = () => {}, cancelSignal, trustedTemplate = false, browserExecutable: selectedBrowser = null }) {
  const { bundle } = await import("@remotion/bundler");
  const { ensureBrowser, renderMedia, selectComposition } = await import("@remotion/renderer");
  const resolvedProjectDir = path.resolve(projectDir);
  const scriptPath = path.join(resolvedProjectDir, "script.json");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`script.json not found in ${projectDir}`);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
  validateScript(script, resolvedProjectDir);
  // The audio plan carries timing overrides and track references that must not
  // touch script.json: the desktop client verifies the script hash separately.
  const audioPlan = loadAudioPlan(resolvedProjectDir);
  const mergedScript = mergeAudioPlan(script, audioPlan, resolvedProjectDir);

  const resolvedOutPath = path.resolve(
    outPath ?? path.join(resolvedProjectDir, "out", "final.mp4"),
  );
  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });

  const draft = quality === "draft";
  const scale = draft ? 0.5 : 1;

  console.log(`[render] script: ${scriptPath}`);
  console.log(`[render] scenes: ${script.scenes.length}`);
  console.log(`[render] audio: ${audioPlan ? "plan present" : "none"}`);
  console.log(`[render] output: ${resolvedOutPath} (${draft ? "draft" : "prod"}, scale ${scale})`);

  const browserExecutable = selectedBrowser ?? detectBrowser();
  if (browserExecutable) {
    console.log(`[render] browser: ${browserExecutable}`);
  } else {
    if (trustedTemplate) throw Object.assign(new Error("No supported browser is installed"), { code: "BROWSER_MISSING" });
    console.log("[render] ensuring chromium (downloading Remotion's shell)…");
    await ensureBrowser();
  }

  onStage("preparing");
  console.log("[render] bundling…");
  // The desktop worker always selects the reviewed local template. Legacy CLI
  // projects may still provide their own entry point as before.
  const jobEntry = path.join(resolvedProjectDir, "src", "index.ts");
  const entryPoint = trustedTemplate || !fs.existsSync(jobEntry) ? ENTRY_POINT : jobEntry;
  const jobPublic = path.join(resolvedProjectDir, "public");
  const publicDir = trustedTemplate || !fs.existsSync(jobEntry)
    ? path.join(resolvedProjectDir, "assets")
    : (fs.existsSync(jobPublic) ? jobPublic : resolvedProjectDir);
  console.log(`[render] entry: ${entryPoint}`);
  console.log(`[render] public: ${publicDir}`);

  // Resolve react/remotion from the local install even when the job carries
  // its own project files (the downloaded folder has no node_modules).
  const webpackOverride = (config) => {
    const modules = config.resolve?.modules;
    return {
      ...config,
      resolve: {
        ...config.resolve,
        modules: Array.isArray(modules)
          ? [LOCAL_NODE_MODULES, ...modules]
          : [LOCAL_NODE_MODULES, "node_modules"],
      },
    };
  };

  const bundleLocation = await bundle({
    entryPoint,
    publicDir,
    webpackOverride,
    onProgress: (progress) => {
      onProgress({ stage: "preparing", progress: Math.min(0.2, progress / 100 * 0.2) });
      if (progress % 25 === 0) console.log(`[render] bundling ${progress}%`);
    },
  });
  console.log(`[render] bundle: ${bundleLocation}`);

  const inputProps = { script: mergedScript };
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "Video",
    inputProps,
    // Without this, selectComposition triggers a Chrome Headless Shell
    // download from storage.googleapis.com, which hangs on networks that
    // cannot reach it. Reuse the browser detected above.
    browserExecutable,
  });
  console.log(
    `[render] composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames`,
  );

  onStage("rendering");
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: resolvedOutPath,
    inputProps,
    crf: draft ? 28 : 18,
    scale,
    overwrite: true,
    browserExecutable: browserExecutable ?? null,
    timeoutInMilliseconds: 600000,
    cancelSignal: cancelSignal ? (cancel) => {
      if (cancelSignal.aborted) cancel();
      else cancelSignal.addEventListener("abort", cancel, { once: true });
    } : undefined,
    onProgress: ({ renderedFrames, progress }) => {
      onProgress({ stage: "rendering", progress });
      if (renderedFrames % 30 === 0) {
        console.log(`[render] frame ${renderedFrames}/${composition.durationInFrames}`);
      }
    },
  });

  const size = fs.statSync(resolvedOutPath).size;
  console.log(`[render] done: ${resolvedOutPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  return { output: resolvedOutPath, bytes: size, duration: composition.durationInFrames / composition.fps };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error("usage: node render.mjs --project <dir> [--out file.mp4] [--quality draft|prod]");
    process.exit(2);
  }
  await renderProject({ projectDir: args.project, outPath: args.out, quality: args.quality });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[render] failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
