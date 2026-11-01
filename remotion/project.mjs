import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const SCENE_TYPES = new Set(["title", "bullets", "image", "video", "text", "endcard"]);
const HASH_CHUNK_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

export function validateScript(script, projectDir) {
  if (!script || typeof script !== "object" || Array.isArray(script)) fail("script.json must contain a JSON object");
  for (const [key, fallback, min, max] of [["fps", 30, 1, 120], ["width", 1920, 1, 7680], ["height", 1080, 1, 4320]]) {
    const value = script[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) fail(`script.${key} must be an integer from ${min} to ${max}`);
  }
  if (!Array.isArray(script.scenes) || script.scenes.length === 0) fail("script.scenes must be a non-empty array");
  for (const [index, scene] of script.scenes.entries()) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) fail(`scene #${index} must be an object`);
    if (!SCENE_TYPES.has(scene.type)) fail(`scene #${index} has unsupported type: ${String(scene.type)}`);
    if (!Number.isFinite(scene.duration) || scene.duration <= 0) fail(`scene #${index} must have a positive duration`);
    if (["image", "video"].includes(scene.type) && !scene.asset) fail(`scene #${index} (${scene.type}) requires an asset`);
    if (scene.asset !== undefined) {
      if (typeof scene.asset !== "string" || !scene.asset || /[\\/]/.test(scene.asset) || path.basename(scene.asset) !== scene.asset || scene.asset === "." || scene.asset === "..") fail(`scene #${index} asset must be a basename`);
      const assetPath = path.resolve(projectDir, "assets", scene.asset);
      if (!assetPath.startsWith(`${path.resolve(projectDir, "assets")}${path.sep}`) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) fail(`scene #${index} asset is missing: ${scene.asset}`);
    }
  }
  return script;
}

export function validatePackage(projectDir) {
  const root = path.resolve(projectDir);
  const scriptPath = path.join(root, "script.json");
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(scriptPath) || !fs.existsSync(manifestPath)) fail("Project must contain script.json and manifest.json");
  const scriptBytes = fs.readFileSync(scriptPath);
  const script = validateScript(JSON.parse(scriptBytes.toString("utf8")), root);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== "octop-remotion-package/1" || manifest.template_version !== "1") fail("Unsupported package manifest schema or template version");
  if (typeof manifest.project_id !== "string" || !manifest.project_id) fail("manifest.project_id is required");
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (manifest.script_sha256 !== sha256(scriptBytes)) fail("script.json SHA-256 does not match manifest");
  if (!Array.isArray(manifest.assets)) fail("manifest.assets must be an array");
  const assetsRoot = path.join(root, "assets");
  if (!fs.existsSync(assetsRoot) || !fs.statSync(assetsRoot).isDirectory()) fail("Project assets directory is missing");
  const realRoot = fs.realpathSync(root);
  const realAssetsRoot = fs.realpathSync(assetsRoot);
  if (!realAssetsRoot.startsWith(`${realRoot}${path.sep}`)) fail("Project assets directory resolves outside the package");
  const listed = new Set();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.path !== "string" || !asset.path.startsWith("assets/")) fail("manifest asset path must start with assets/");
    const name = asset.path.slice("assets/".length);
    if (!name || /[\\/]/.test(name) || path.basename(name) !== name || listed.has(name)) fail(`Invalid or duplicate manifest asset path: ${asset.path}`);
    listed.add(name);
    const fullPath = path.join(root, "assets", name);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) fail(`Manifest asset is missing: ${asset.path}`);
    const realPath = fs.realpathSync(fullPath);
    if (!realPath.startsWith(`${realAssetsRoot}${path.sep}`)) fail(`Manifest asset resolves outside assets/: ${asset.path}`);
    const { bytes, sha256: actualHash } = hashFile(fullPath);
    if (asset.bytes !== bytes || asset.sha256 !== actualHash) fail(`Asset hash or size does not match manifest: ${asset.path}`);
  }
  for (const scene of script.scenes) if (scene.asset && !listed.has(scene.asset)) fail(`Asset is not listed in manifest: ${scene.asset}`);
  return { root, script, manifest };
}

export function hashFile(filePath) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = fs.openSync(filePath, "r");
  let bytes = 0;
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export function studioArgs({ cliEntry, entryPoint, projectDir, propsPath }) {
  return { command: process.execPath, args: [cliEntry, "studio", entryPoint, `--props=${propsPath}`, `--public-dir=${path.join(projectDir, "assets")}`, "--force-new"] };
}

export function propsDocument(script) {
  return JSON.stringify({ script });
}

export const AUDIO_PLAN_FILE = "audio.json";

/**
 * Read the optional audio plan that sits next to script.json.
 *
 * Keeping audio out of script.json is deliberate: the desktop client verifies
 * the semantic hash of script.json against the confirmed plan, so the picture
 * script must stay exactly what the user approved. Timing overrides and audio
 * references travel separately and are merged in at load time.
 */
export function loadAudioPlan(root) {
  const planPath = path.join(root, AUDIO_PLAN_FILE);
  if (!fs.existsSync(planPath)) return null;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("audio.json must contain a JSON object");
  return plan;
}

function assetBasename(value, label) {
  if (typeof value !== "string" || !value || /[\\/]/.test(value) || path.basename(value) !== value || value === "." || value === "..") {
    fail(`${label} must be a basename`);
  }
  return value;
}

/**
 * Apply an audio plan to a script without mutating the original.
 *
 * Scene durations are overridden to land on bar lines, and narration clips are
 * attached only when the file is actually present — `mode: "local"` packages
 * start without them and the desktop client fills them in before rendering.
 */
export function mergeAudioPlan(script, plan, root) {
  if (!plan) return script;
  const assetsRoot = path.join(root, "assets");
  const present = (name) => {
    const full = path.join(assetsRoot, name);
    return fs.existsSync(full) && fs.statSync(full).isFile();
  };
  const merged = { ...script };
  const audio = {};
  if (plan.bgm && typeof plan.bgm === "object") {
    const src = assetBasename(plan.bgm.src, "audio.bgm.src");
    if (present(src)) audio.bgm = { ...plan.bgm, src };
  }
  if (plan.narration && typeof plan.narration === "object") {
    audio.narration = { mode: "off", ...plan.narration };
  }
  if (Object.keys(audio).length > 0) merged.audio = audio;

  const overrides = plan.scenes && typeof plan.scenes === "object" ? plan.scenes : {};
  merged.scenes = script.scenes.map((scene) => {
    const override = scene.id ? overrides[scene.id] : null;
    if (!override || typeof override !== "object") return scene;
    const next = { ...scene };
    if (Number.isFinite(override.duration) && override.duration > 0) next.duration = override.duration;
    if (typeof override.narration === "string" && override.narration) next.narration = override.narration;
    if (override.audio && typeof override.audio === "object" && override.audio.src) {
      const src = assetBasename(override.audio.src, `scene ${scene.id} audio src`);
      if (present(src)) {
        next.audio = { src, volume: Number.isFinite(override.audio.volume) ? override.audio.volume : 1 };
      }
    }
    return next;
  });
  return merged;
}
