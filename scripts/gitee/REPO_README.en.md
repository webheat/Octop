# Octop client downloads

Octop is an open-source, self-hosted AI assistant platform: multi-user,
multi-agent, deployed as a single process with no external queue or broker.
This repository distributes the **Octop desktop client** builds.

> The source code is not in this repository. See
> [GitHub](https://github.com/TencentCloud/Octop) /
> [CNB](https://cnb.cool/mengxa.com/Octop) — this repository holds the
> download page and the release artifacts only.

## Two steps and you are done

1. **Install the client** (Windows, ~6 MB)
2. **Install the video components** (~71 MB) — video renders locally, without
   these you cannot export a video

The client connects to the Octop server we already deployed: sign-in, product
library, AI storyboards and plan approval all live on the server; the client
only renders the UI and the video, and **no Python runtime is needed locally**.

These builds are not code-signed, so Windows SmartScreen may warn about an
unknown publisher — choose **More info → Run anyway**. This round ships the
Windows build only; macOS and Linux are not published yet.

## 1. The client

| System | Download | Size |
|---|---|---|
| Windows 10/11 x64 | [Octop-desktop-windows-amd64-{{VERSION}}.exe]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-desktop-windows-amd64-{{VERSION}}.exe) | ~6 MB |
| Windows on ARM (Snapdragon X and similar) | [Octop-desktop-windows-arm64-{{VERSION}}.exe]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-desktop-windows-arm64-{{VERSION}}.exe) | ~5.5 MB |

Every release is listed under [Releases]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases).
The client talks to <https://ocbot.aixifs.com/videogen> directly.

## 2. Video components (required)

The desktop client does **not** bundle the video rendering environment (Node +
Remotion + browser, ~500 MB unpacked). It is installed once, separately. Not
installing it does not affect sign-in, the product library or storyboard
editing — only local video production.

| Component | Size | Download |
|---|---|---|
| **Video components (Windows x64)** | ~71 MB | [Download]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-video-components-windows-x64-{{VERSION}}.exe) |

Install steps:

1. Run the component installer with the defaults (installs to
   `%LOCALAPPDATA%\Octop\video-runtime`, per-user, no admin rights, no PATH changes).
2. Go back to **Produce product video** in the client and click **Re-check**.
3. The client renders a few seconds of test video; once it shows
   "local production ready", you can produce real videos.

The client shows the same download button; you only see "contact your
administrator" when the URL is unavailable.

## Need your own server?

This page carries the remote client only. A self-contained installer that
bundles the Python runtime starts at 200 MB, above Gitee's 100 MB attachment
limit, so it is not distributed here. For offline or private deployments,
follow the deployment guide in the source repository.

## Documentation

- Guides: <https://github.com/TencentCloud/Octop/tree/main/docs>
- API reference: <https://github.com/TencentCloud/Octop/blob/main/docs/api.md>

## License

MIT — see the source repository.
