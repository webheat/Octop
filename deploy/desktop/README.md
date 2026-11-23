# Desktop client: "no component download address configured"

> A real-world pitfall: the client compiled fine and reached the remote server,
> but clicking **"Install components"** reported that no component download
> address was configured. The cause is not the detection module — it is **one
> missing ldflag at compile time**.
>
> **This is not just a local hand-written `go build` problem — the CI packaging
> path does not carry the address either.** The already-published green client
> is fine (it was hand-injected), but the next automatic CI publish would ship
> a client that cannot install components.
>
> Applies to: `v1.4.0` / `desktop-v1.4.1` (written against `develop` @ `cacbe146`).

---

## 1. Symptom

The client starts normally and the remote server responds:

```
[fetch] url=https://ocbot.aixifs.com/videogen/api/setup/status status=200
```

On the "Video environment" page, clicking "Install components" says the
component download address is not configured.

The decisive line is in `desktop/src/bin/desktop-nav.log` (or `<octop home>/logs/`):

```
video env: check found no runtime directory (RUNTIME_MISSING); the components must be installed
video environment state=needs_setup stage=none code=RUNTIME_MISSING requiresInstall=true
video install: no components manifest URL is configured (build-time default is empty)
```

Note the parenthetical: **`build-time default is empty`** — the compile-time default
was blank. Not a network problem, not an expired token, not DNS.

The user-visible copy is `dashboard/src/locales/zh.json:766`:

```json
"NO_INSTALLER": "当前客户端未配置组件下载地址，请在桌面客户端打开本页或联系管理员。"
```

---

## 2. Root cause

The component address is a **compile-time constant** injected via `-ldflags -X`.

`desktop/src/main.go:36`

```go
// defaultVideoComponentsURL is the URL of the video components manifest,
// baked in via -ldflags "-X main.defaultVideoComponentsURL=https://.../manifest.json".
// Empty means the UI falls back to the "contact administrator" guidance.
var defaultVideoComponentsURL string
```

The consumer: `desktop/src/video_install.go:111`

```go
urls := manifestURLs(firstNonEmpty(os.Getenv("OCTOP_DESKTOP_VIDEO_COMPONENTS_URL"), defaultVideoComponentsURL))
if len(urls) == 0 {
    m.mu.Unlock()
    navLogf("video install: no components manifest URL is configured (build-time default is empty)")
    return VideoEnvironmentStatus{}, videoErr("NO_INSTALLER")
}
```

An empty `defaultVideoComponentsURL` yields `NO_INSTALLER`, and the frontend
`dashboard/src/pages/VideoEnvironment/index.tsx:179` renders
`videoEnvironment.installerUnavailable` (en.json:389, "Open this page in the
desktop client to install, or contact your administrator.").

### Why it gets missed: three separate breaks

The download address was **never managed as a build input**. It lives only in
docs and in an ops script's stdout.

> ⚠️ **A common misconception, worth correcting**: the **released green client
> is fine** — its binary **does** carry the component address, and "Install
> components" works (measured in §2.1). What lacks it is a **hand-written
> `go build`** that skips the Taskfile, and the **CI packaging path**.
> See the comparison table in §2.1.

**① The Taskfile global defaults to an empty string** — `desktop/src/Taskfile.yml:21`

```yaml
  # Optional HTTPS URL for the separately built video component installer.
  # Leave empty until an official release asset is available.
  VIDEO_COMPONENTS_URL: ""
```

The comment says "leave empty until an official release asset is available" — but
the asset **has been published** (1.4.0, 2026-11-20). Compare `:18` in the same
file, `DEFAULT_SERVER_URL: "https://ocbot.aixifs.com/videogen"`: the server URL
has a default, the component URL does not.

**② The ldflags template injects conditionally** — `desktop/src/build/windows/Taskfile.yml:24`

```
{{if .VIDEO_COMPONENTS_URL}} -X main.defaultVideoComponentsURL={{.VIDEO_COMPONENTS_URL}}{{end}}
```

Empty → the whole segment is not generated → the variable in `main.go:36` stays
empty → `video_install.go:111` returns `NO_INSTALLER`. **The build still
succeeds, with no warning.**

**③ CI never passes the variable** — `.github/workflows/octop-desktop.yml:340, 352, 364, 372`

All four `wails3 task package` / `package:green` / `package:green:slim` calls omit
`VIDEO_COMPONENTS_URL`, relying entirely on that empty global. **A green client
built by CI will lack the address.**

**④ `package-release.sh` wipes the global default** — `desktop/package-release.sh:118`

```bash
wails3 task package ... "VIDEO_COMPONENTS_URL=${video_components_url}"
```

`video_components_url` comes from `${OCTOP_DESKTOP_VIDEO_COMPONENTS_URL-}` at
`:72`, empty when unset. go-task semantics (measured): **an explicitly passed
empty value overrides the global default**; only omitting it inherits.

```
$ wails3 task show              → FOO=[global-default]   # omitted: inherits
$ wails3 task show FOO=         → FOO=[]                 # empty: overrides
$ wails3 task show FOO=xyz      → FOO=[xyz]
```

So even after filling in the `Taskfile.yml:21` global, this line would blank it
again. **Both must change together.**

### 2.1 The released client is fine (important correction)

You may see the claim that "the shipped client also lacks the address" — **it is
wrong**. The binary usually inspected for this,
`C:\Octop_v0\desktop\src\bin\Octop.exe`, is a **local build artifact ignored by
git** (`desktop/src/.gitignore:1` is `bin/`), not a release artifact.

Measured across three binaries (`grep -a -o -E 'https?://[a-z0-9.-]*mengxa\.com[^"[:space:]]*'`):

| Binary | Origin | `mengxa` | Baked component URL |
|---|---|---|---|
| `C:\Octop_v0\desktop\src\bin\Octop.exe`<br>(2026-11-19, 13.6 MB) | **local** build artifact, gitignored | **0** | **none** |
| `Downloads\Octop.exe` (2026-11-22 07:08) | **published artifact**, sha256 `26cc6788…` | 1 | https + http + IP (3 entries) |
| Gitee `v1.4.1-gitee.8` → `Octop.exe`<br>(published 2026-11-22) | **published artifact**, sha256 `26cc6788…` | 1 | same |

The last two are byte-identical, and their sha256 matches the value published in
the Gitee Release notes —
`26cc678858f632bfd22e8d29e8072ae92dfa573a6b51156bbeb25b9de4db0d94`. **That is
literally the file being distributed.**

The baked value is:

```
https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,
http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,
http://175.178.192.87/video-components/1.4.0/win-x64/manifest.json
```

(Three entries, including the direct IP — the recipe in `docs/PRD.md:269`.
`docs/RELEASE-MATRIX.md:90` later dropped it to the two domain-only entries; see §4.)

**Corroboration: the shipped client's "Install components" really did run.**
`~/.octop/logs/desktop-nav.log` (the old log location), 2026-11-22 07:11:

```
video install: started, manifest urls=[https://dw.mengxa.com/... http://dw.mengxa.com/... http://175.178.192.87/...]
video install: manifest loaded version=1.4.0-win-x64-node24.14.0 platform=win-x64 parts=2
video install: target dir=C:\Users\Admin\Downloads\video-runtime cache=C:\Users\Admin\.octop\desktop-video-environment\install
video install: progress part=core received=1103746/109800203 total=0.5%
```

`target dir` points at `Downloads\video-runtime` — the **exe-adjacent** directory —
so the binary that ran was `Downloads\Octop.exe`, the published file that carries
the address. The download completed: `~/.octop/desktop-video-environment/install/parts/`
holds `core.zip` (109,800,203 B) and `browser.zip` (125,919,250 B), sha256 matching
the manifest.

**Conclusion**: the published artifact was **hand-built** with the URL injected,
via the `OCTOP_DESKTOP_VIDEO_COMPONENTS_URL` environment variable
(`desktop/package-release.sh:72`) or direct ldflags. **The CI path does not do
that.** So the real risk is: **the next time CI publishes automatically, it ships
a client that cannot install components — and nothing errors.**

### A contributing trap: `wails3 task` is entirely broken on this host

`desktop/src/build/windows/Taskfile.yml:192` and `:214` use `sh:` as a cmds key:

```yaml
- sh: 'mkdir -p "{{.ROOT_DIR}}/bin/green-webview2" && wails3 generate webview2bootstrapper ...'
- sh: '"{{.MAKENSIS}}" -VERSION'
```

wails3 v3.0.0-beta.13 rejects that key:

```
ERROR  err:  invalid keys in command
  file: desktop/src/build/windows/Taskfile.yml:192:9
```

**Note: go-task parses the entire Taskfile before selecting a task, so *every*
`wails3 task` under `desktop/src` fails** — `wails3 task build:frontend` reports
the same error. It is not confined to the `create:green:zip` chain.

That syntax arrived in commit `180dd6a9` ("feat(desktop): Windows 免安装 zip
（green）打包"), which is on `fork/develop` but **not** on `origin/develop` —
so upstream CI never exposed it.

This pushes people toward hand-written `go build`, which is exactly where the
`-X` flag gets dropped.

---

## 3. How to build it correctly

### 3.0 How this was actually fixed

Symptom: the client reached the remote server, logged in, and opened the "Video
environment" page, but "Install components" reported that no component download
address was configured.

Diagnosis: the line in `bin/desktop-nav.log` —
`video install: no components manifest URL is configured (build-time default is empty)`
— says the compile-time variable is blank. Not a network or permission problem.

Fix: **rebuild with the missing ldflag** — append
`-X main.defaultVideoComponentsURL=<two-scheme URL>` to the original command:

```bash
cd desktop/src
go build -buildvcs=false -tags "production,thin" \
  -ldflags="-X main.defaultServerURL=https://ocbot.aixifs.com/videogen \
            -X main.defaultVideoComponentsURL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json" \
  -o bin/Octop.exe .
```

Verify (both URLs must be greppable in the binary):

```bash
grep -a -o -E 'https?://[A-Za-z0-9._/-]*mengxa\.com[A-Za-z0-9._/-]*' bin/Octop.exe | sort -u
# http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
# https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
```

After restarting the client, the `no components manifest URL` count in the navlog
drops to zero and "Install components" downloads the components as expected.

> **No production code was changed** — what was missing was a build argument, not
> a code bug. All three build styles below avoid the trap.

### Option A: via the Taskfile (recommended)

```bash
cd desktop/src
wails3 task build PRODUCTION=true \
  DEFAULT_SERVER_URL=https://ocbot.aixifs.com/videogen \
  VIDEO_COMPONENTS_URL="https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json"
```

### Option B: via package-release.sh (release builds)

```bash
export OCTOP_DESKTOP_VIDEO_COMPONENTS_URL="https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json"
./desktop/package-release.sh --platform windows-x64
```

The script forwards it as `VIDEO_COMPONENTS_URL` to `wails3 task package`
(`desktop/package-release.sh:118`).

### Option C: hand-written go build (ad-hoc debugging)

**Both ldflags must appear together**:

```bash
cd desktop/src
go build -buildvcs=false -tags "production,thin" -ldflags="-X main.defaultServerURL=https://ocbot.aixifs.com/videogen -X main.defaultVideoComponentsURL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json" -o bin/Octop.exe .
```

---

## 4. Where the component address comes from

| Item | Value |
|---|---|
| Primary URL | `https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json` |
| Mirror URL | `http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json` |
| Published version | `1.4.0` (the `1.4.1` / `1.5.0` paths both 404) |
| Version source | `pyproject.toml:7` → `version = "1.4.0"`, matching `scripts/release-video-components.sh:172` |
| Manifest content | `schema: octop-desktop-video-components/1`, `version: 1.4.0-win-x64-node24.14.0`, `platform: win-x64` |
| Parts | `core.zip` (109.8 MB), `browser.zip` (125.9 MB), each with `connections: 4` |

`scripts/release-video-components.sh` prints the URL to inject after a successful
publish (`scripts/release-video-components.sh:387`) — copy it verbatim.

### Why **both schemes** must be baked in (multi-node)

`dw.mengxa.com` round-robins DNS across 4 IPs whose TLS/site configuration is
**not** uniform:

| IP | HTTPS | HTTP | Notes |
|---|---|---|---|
| `1.14.182.208` | ✅ 200 | ✅ 206 | Healthy node |
| `175.178.33.107` | ✅ 200 | 301→HTTPS | HTTPS fine; **HTTP only redirects, serves no files** |
| `175.178.192.87` | ❌ SNI mismatch | ✅ 206 | **Serves HTTP only** |
| `8.134.147.195` | ❌ expired `CN=ymxt.top` cert | 403 | **Deliberate fault node** for resilience testing |

- Probing HTTPS alone misclassifies the "HTTP-only" healthy node as dead and
  throws away half the bandwidth — the client therefore probes by `host|scheme`
  and maintains a usable-node list per port.
- Do **not** remove `8.134.147.195` from DNS; that would void the failover test.
  `componentsDownloadClient` probes per IP and skips it automatically.
- The probe **does not follow redirects** — a 3xx counts as unusable for that
  scheme (otherwise `175.178.33.107`'s HTTP 301 would look healthy).

See `docs/desktop-windows-build.md` §3.5 and `docs/PRD.md`.

---

## 5. Post-build checklist

```bash
# 1) both URLs present in the binary
grep -a -o -E 'https?://[A-Za-z0-9._/-]*mengxa\.com[A-Za-z0-9._/-]*' bin/Octop.exe | sort -u
# expected:
#   http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
#   https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json

grep -a -o -E 'https?://ocbot[A-Za-z0-9._/-]*' bin/Octop.exe | sort -u
# expected: https://ocbot.aixifs.com/videogen

# 2) manifest actually reachable (both schemes must be 200)
curl -sS -o /dev/null -w '%{http_code}\n' https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
curl -sS -o /dev/null -w '%{http_code}\n' http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json

# 3) navlog must no longer contain this line
grep -c "no components manifest URL" bin/desktop-nav.log
# expected: 0
```

---

## 6. Decision tree

```
Client reports "no component download address configured"
│
├─ navlog has "no components manifest URL is configured (build-time default is empty)"
│   → Missing at compile time. Run checklist step 1. Rebuild with the ldflag.
│
├─ No such line in navlog, but the UI still says unavailable
│   → The frontend reads window.octopDesktopVideo.environmentInstallerURL,
│     injected from video_bridge.go:95. Confirm the webview loaded a page under
│     the /videogen prefix and that the bridge injection succeeded
│     (navlog shows "injecting probe").
│
├─ NO_INSTALLER / DOWNLOAD_FAILED with "manifest could not be loaded"
│   → The URL is set but unreachable. Run checklist step 2; confirm the version
│     (only 1.4.0 exists today).
│
└─ RUNTIME_MISSING / BROWSER_MISSING
    → The components did not install. Verify after a successful install.
```

---

## 7. Code map

| File:line | Role |
|---|---|
| `desktop/src/main.go:36` | `defaultVideoComponentsURL` declaration (ldflags injection point) |
| `desktop/src/main.go:63` | `resolveRemoteDashboardURL()` — server URL, env wins |
| `desktop/src/video_install.go:111` | Reads the URL; empty → `NO_INSTALLER` |
| `desktop/src/video_install.go:75` | `manifestURLs()` — comma-separated multi-URL parse + validation |
| `desktop/src/video_environment.go:52` | `sanitizeEnvironmentInstallerURL()` |
| `desktop/src/video_bridge.go:95` | Injects the primary URL into the frontend as `window.octopDesktopVideo.environmentInstallerURL` |
| `desktop/src/Taskfile.yml:21` | `VIDEO_COMPONENTS_URL` global var (defaults empty ← trap ①) |
| `desktop/src/build/windows/Taskfile.yml:24` | BUILD_FLAGS ldflags assembly (conditional) |
| `desktop/src/build/windows/Taskfile.yml:192, 214` | `sh:` keys — unsupported by wails3 v3.0.0-beta.13; breaks every task in the file |
| `desktop/package-release.sh:72` | Reads `OCTOP_DESKTOP_VIDEO_COMPONENTS_URL` (defaults empty) |
| `desktop/package-release.sh:118` | Forwards it as `VIDEO_COMPONENTS_URL` to `wails3 task package` (**an explicit empty value overrides the global**) |
| `scripts/release-video-components.sh:172` | Reads the version from `pyproject.toml` |
| `scripts/release-video-components.sh:387` | Prints the URL to inject after publishing |
| `.github/workflows/octop-desktop.yml:340,352,364,372` | The four CI packaging calls, **none passes `VIDEO_COMPONENTS_URL`** |
| `dashboard/src/locales/zh.json:766` | `NO_INSTALLER` user copy |
| `dashboard/src/pages/VideoEnvironment/index.tsx:179` | Frontend `installerUnavailable` notice |
| `docs/desktop-windows-build.md` §3.5 | Full packaging and baking notes |

---

## 8. Suggested fixes (not implemented yet)

### (a) Single source of truth: add `desktop/video-components.env`

Commit it to the repo, replacing the duplicated literals scattered across
`docs/desktop-windows-build.md:151,186,244`:

```
OCTOP_VIDEO_COMPONENTS_URL=https://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json,http://dw.mengxa.com/video-components/1.4.0/win-x64/manifest.json
```

The version matches `pyproject.toml:7` (`1.4.0`) and the release script's
behaviour of reading the version from pyproject.

### (b) Make `desktop/src/Taskfile.yml:21` read that file

go-task's `vars` support `sh:`, and a root Taskfile's globals are readable by
included sub-Taskfiles:

```yaml
  VIDEO_COMPONENTS_URL:
    sh: 'cat "{{.ROOT_DIR}}/../../video-components.env" 2>/dev/null | sed -nE "s/^OCTOP_VIDEO_COMPONENTS_URL=(.*)$/\1/p"'
```

CI does not pass the variable → the global applies → all four
`wails3 task package` calls pick it up automatically.

### (c) Make `desktop/package-release.sh:118` stop passing an empty value

Append `VIDEO_COMPONENTS_URL=...` only when the env var is non-empty; otherwise
leave it to the Taskfile global. **Otherwise (b) is wiped out** (go-task: an
explicit empty value overrides the global — measured).

### (d) Have `scripts/release-video-components.sh` rewrite that env file after publishing

It already knows `ALL_URLS` (`:386`), so it can write it back. Update the
hand-copy step in `docs/desktop-windows-build.md` to "read the file" instead.

### (e) Add a build-time assertion — this is the key to "never miss it again"

Add a step after packaging in CI:

```bash
strings bin/Octop.exe | grep -q 'dw.mengxa.com' || { echo "::error::defaultVideoComponentsURL was not injected"; exit 1; }
```

Put the assertion in **CI**, not in the Taskfile — the Taskfile path is itself
broken right now (see (f)).

### (f) Fix the `sh:` keys at `build/windows/Taskfile.yml:192,214` first

Change them to `cmd: sh -c '...'` (whether the fork supports `sh:` under
`preconditions` is unverified). **Until this is fixed, no Taskfile fix can be
validated** — it just keeps pushing people toward hand-written `go build`.

### (g) Sharpen the frontend copy

`installerUnavailable` currently gives one message for two different situations
— "not in the desktop client" and "in the desktop client but no address was
compiled in" — which sends debugging in the wrong direction. The `NO_INSTALLER`
copy (zh.json:766) is more accurate, but the two should be unified.

---

## 9. Related finding: two inconsistent sources of truth

`video_bridge.go:95` uses only the baked `defaultVideoComponentsURL` to compute
the frontend bridge's `environmentInstallerURL`, while `video_install.go:111`
prefers the env var:

```
video_install.go:111  firstNonEmpty(os.Getenv("OCTOP_DESKTOP_VIDEO_COMPONENTS_URL"), defaultVideoComponentsURL)
video_bridge.go:95    manifestURLs(defaultVideoComponentsURL)
```

Consequence: **setting `OCTOP_DESKTOP_VIDEO_COMPONENTS_URL` at runtime lets the
components install, but the frontend receives an empty installer URL.** Today no
page in `dashboard/src` actually consumes `environmentInstallerURL` (only
`DesktopVideoJobsContext.tsx:442` passes it through), so there is no visible
impact — but the moment the frontend uses it to decide whether installation is
possible, this inconsistency becomes a bug.
