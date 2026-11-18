import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const WORKER = fileURLToPath(new URL("../desktop-worker.mjs", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function packageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octop-video-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "assets"), { recursive: true });
  const script = Buffer.from(JSON.stringify({ fps: 1, width: 640, height: 360, scenes: [{ type: "title", duration: 1, text: "Smoke" }] }));
  fs.writeFileSync(path.join(project, "script.json"), script);
  fs.writeFileSync(path.join(project, "manifest.json"), JSON.stringify({ schema: "octop-remotion-package/1", template_version: "1", project_id: "smoke", script_sha256: hash(script), assets: [] }));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: "octop-desktop-video-runtime/1", templateVersion: 1 }));
  return { root, project };
}

test("worker emits only JSONL and rejects tampered project data without executing project code", (t) => {
  const { root, project } = packageFixture(t);
  fs.writeFileSync(path.join(project, "script.json"), JSON.stringify({ type: "module", scenes: [] }));
  fs.writeFileSync(path.join(project, "evil.mjs"), "throw new Error('must never run');");
  const result = spawnSync(process.execPath, [WORKER, "--project", project, "--out", path.join(root, "out.mp4")], { cwd: root, encoding: "utf8", env: { ...process.env, OCTOP_DESKTOP_VIDEO_RUNTIME: root } });
  assert.equal(result.status, 1);
  const messages = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(messages, [{ type: "error", code: "RUNTIME_MISSING" }]);
});

test("check reports missing components as needs_setup without invoking downloads", (t) => {
  const { root } = packageFixture(t);
  const cache = path.join(root, "cache");
  const result = spawnSync(process.execPath, [WORKER, "--check", "--cache", cache], { cwd: root, encoding: "utf8", env: { ...process.env, OCTOP_DESKTOP_VIDEO_RUNTIME: root } });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.at(-1).state, "needs_setup");
  assert.equal(events.at(-1).errorCode, "RUNTIME_MISSING");
  assert.equal(events.at(-1).requiresInstall, true);
  assert.equal(fs.existsSync(path.join(cache, "node_modules")), false);
});

test("check with no host browser reports BROWSER_MISSING without launching a browser", (t) => {
  const { root } = packageFixture(t);
  fs.writeFileSync(path.join(root, process.platform === "win32" ? "node.exe" : "node"), "test runtime marker");
  const emptyProfile = path.join(root, "empty-profile");
  fs.mkdirSync(emptyProfile);
  const result = spawnSync(process.execPath, [WORKER, "--check", "--cache", path.join(root, "cache")], {
    cwd: root,
    encoding: "utf8",
    // Windows restores the real ProgramFiles value inside child processes,
    // so pointing it at an empty directory is not enough to describe a
    // machine without a browser. The explicit switch is.
    env: { ...process.env, OCTOP_DESKTOP_VIDEO_RUNTIME: root, LOCALAPPDATA: emptyProfile, ProgramFiles: emptyProfile, "ProgramFiles(x86)": emptyProfile, REMOTION_BROWSER_EXECUTABLE: path.join(emptyProfile, "missing.exe"), OCTOP_VIDEO_NO_SYSTEM_BROWSER: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.at(-1).state, "needs_setup");
  assert.equal(events.at(-1).errorCode, "BROWSER_MISSING");
  assert.equal(events.at(-1).stage, "browser");
});

test("worker rejects missing or extra native arguments", (t) => {
  const { root } = packageFixture(t);
  const result = spawnSync(process.execPath, [WORKER, "--project", root, "--out", path.join(root, "out.mp4"), "--shell", "bad"], { cwd: root, encoding: "utf8", env: { ...process.env, OCTOP_DESKTOP_VIDEO_RUNTIME: root } });
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)), [{ type: "error", code: "RENDER_FAILED" }]);
});
