# Octop client downloads

Octop is an open-source, self-hosted AI assistant platform: multi-user,
multi-agent, deployed as a single process with no external queue or broker.
This repository distributes the **Octop desktop client** builds.

> The source code is not in this repository. See
> [GitHub](https://github.com/TencentCloud/Octop) /
> [CNB](https://cnb.cool/mengxa.com/Octop) — this repository holds the
> download page and the release artifacts only.

## Unzip and run

The **green build** needs no installation: unzip it into any writable folder
and double-click `Octop.exe`. No installer wizard, nothing written to
Program Files, no registry entries, no system PATH changes.

The client connects to the Octop server we already deployed: sign-in, product
library, material library, AI storyboards and plan approval all live on the
server; the client only renders the UI and the video, and **no Python runtime
is needed locally**.

These builds are not code-signed, so Windows SmartScreen may warn about an
unknown publisher — choose **More info → Run anyway**. This round ships the
Windows build only; macOS and Linux are not published yet.

## 1. The client

| System | Download | Size |
|---|---|---|
| Windows 10/11 x64 | [Octop-green-windows-amd64-{{VERSION}}.zip]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-green-windows-amd64-{{VERSION}}.zip) | 5.3 MB |

The folder holds two files after unzipping: `Octop.exe` (the program) and
`README.txt`.

> If you only need the program, [Octop.exe]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop.exe) (12.5 MB)
> is available on its own — without the bundled instructions.

Every release is listed under [Releases]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases).

## 2. Video rendering environment (install it only when you need to export)

This build does **not** bundle the local rendering engine (Node + Remotion +
Chromium, ~228 MB). When you want to export a video, open the **Video
environment** page in the client and click **Install in one click** — it is
downloaded from the server and unpacked into a `video-runtime/` folder next to
the program.

- Until then that page shows "installation required"; **every other feature
  works as usual**.
- The first install downloads about 228 MB, depending on your connection.
- Afterwards click **Re-check**; once it shows "local production ready" you
  can produce real videos.

## Requirements

- Microsoft Edge WebView2 Runtime (shipped with Windows 11 and most Windows 10).
- Unzip the client into a **writable folder** (not `C:\Program Files`): the
  video environment is installed next to the program.
- After the video environment is installed the folder gains a `video-runtime/`
  subdirectory (about 500 MB).

## Documentation

- Guides: <https://github.com/TencentCloud/Octop/tree/main/docs>
- API reference: <https://github.com/TencentCloud/Octop/blob/main/docs/api.md>

## License

MIT — see the source repository.
