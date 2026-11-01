#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadAudioPlan, mergeAudioPlan, propsDocument, studioArgs, validatePackage } from "./project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const options = { project: path.resolve(HERE, ".."), render: false, dryRun: false, quality: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project") {
      if (!argv[i + 1]) throw new Error("--project requires a directory");
      options.project = path.resolve(argv[++i]);
    } else if (argv[i] === "--render") options.render = true;
    else if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--quality") {
      const quality = argv[++i];
      if (!["draft", "prod"].includes(quality)) throw new Error("--quality must be draft or prod");
      options.quality = quality;
    }
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

export function resolveCliEntry() {
  let directory = path.dirname(require.resolve("@remotion/cli"));
  for (;;) {
    const packagePath = path.join(directory, "package.json");
    if (fs.existsSync(packagePath)) {
      const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (metadata.name === "@remotion/cli") {
        const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.remotion;
        if (!bin) throw new Error("Installed @remotion/cli package does not declare a remotion bin");
        return path.resolve(directory, bin);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Could not locate @remotion/cli package.json");
    directory = parent;
  }
}

export function installState(rendererDir) {
  const lockPath = path.join(rendererDir, "package-lock.json");
  const markerPath = path.join(rendererDir, ".octop-npm-ci.json");
  const lockHash = createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
  let markerHash = null;
  try { markerHash = JSON.parse(fs.readFileSync(markerPath, "utf8")).lock_sha256; } catch { /* first run or stale marker */ }
  let cliInstalled = false;
  try {
    const cliPackagePath = path.join(rendererDir, "node_modules", "@remotion", "cli", "package.json");
    const metadata = JSON.parse(fs.readFileSync(cliPackagePath, "utf8"));
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.remotion;
    cliInstalled = metadata.name === "@remotion/cli" && typeof bin === "string" && fs.existsSync(path.join(path.dirname(cliPackagePath), bin));
  } catch { /* npm ci is required */ }
  return { npmInstall: markerHash !== lockHash || !cliInstalled, markerPath, lockHash };
}

export function plan(options) {
  const { root, script } = validatePackage(options.project);
  // Studio previews the same picture the renderer will produce, so the audio
  // plan has to be merged here as well.
  const audioPlan = loadAudioPlan(root);
  const mergedScript = mergeAudioPlan(script, audioPlan, root);
  const rendererDir = HERE;
  const { npmInstall, markerPath, lockHash } = installState(rendererDir);
  if (options.render) {
    const args = [path.join(rendererDir, "render.mjs"), "--project", root];
    if (options.quality) args.push("--quality", options.quality);
    return { mode: "render", root, rendererDir, npmInstall, markerPath, lockHash, command: process.execPath, args };
  }
  if (npmInstall) return { mode: "preview", root, rendererDir, npmInstall, markerPath, lockHash, script: mergedScript };
  const cliEntry = resolveCliEntry();
  const propsPath = path.join(os.tmpdir(), `octop-remotion-props-${process.pid}.json`);
  const command = studioArgs({ cliEntry, entryPoint: path.join(rendererDir, "src", "index.ts"), projectDir: root, propsPath });
  return { mode: "preview", root, rendererDir, npmInstall, markerPath, lockHash, script: mergedScript, propsPath, ...command };
}

function spawnNpmCi(cwd) {
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec || "cmd.exe" : "npm";
  const args = isWindows ? ["/d", "/s", "/c", "npm.cmd", "ci"] : ["ci"];
  return spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code ?? 1}`)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    console.error("[preview] Node.js 22 or newer is required.");
    process.exitCode = 1;
    return;
  }
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`[preview] ${error.message}`); process.exitCode = 2; return; }
  let execution;
  try { execution = plan(options); } catch (error) { console.error(`[preview] ${error.message}`); process.exitCode = 1; return; }
  console.log(`[preview] project: ${execution.root}`);
  console.log(`[preview] mode: ${execution.mode}`);
  if (options.dryRun) {
    console.log(JSON.stringify({ ...execution, script: undefined, npmInstall: execution.npmInstall }, null, 2));
    return;
  }
  try {
    if (execution.npmInstall) {
      await runNpmInstall(execution.rendererDir);
      fs.writeFileSync(execution.markerPath, JSON.stringify({ lock_sha256: execution.lockHash }), "utf8");
      execution = plan(options);
    }
    if (execution.mode === "preview") {
      fs.writeFileSync(execution.propsPath, propsDocument(execution.script), "utf8");
      await run(execution.command, execution.args, execution.rendererDir);
    } else {
      await run(execution.command, execution.args, execution.rendererDir);
    }
  } catch (error) {
    console.error(`[preview] ${error.message}`);
    if (error.code === "ENOENT") console.error("Install Node.js 22 or newer (including npm), then try again.");
    process.exitCode = 1;
  } finally {
    if (execution?.propsPath) fs.rmSync(execution.propsPath, { force: true });
  }
}

async function runNpmInstall(cwd) {
  await new Promise((resolve, reject) => {
    const child = spawnNpmCi(cwd);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm ci exited with code ${code ?? 1}`)));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
