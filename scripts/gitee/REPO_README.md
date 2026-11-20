# Octop 客户端下载

Octop 是一个开源自托管的 AI 助手平台：多用户、多智能体，单进程部署，不需要额外的
队列或中间件。本仓库用于分发 **Octop 桌面客户端** 的发行产物。

> 源码不在本仓库。源码见 [GitHub](https://github.com/TencentCloud/Octop) /
> [CNB](https://cnb.cool/mengxa.com/Octop)，本仓库只放下载页与 Release 产物。

## 解压即用

**绿色版**不需要安装：解压到任意可写目录，双击 `Octop.exe` 就能用。
不需要安装向导，不写 Program Files，不写注册表，不改系统 PATH。

客户端连接我们已部署好的 Octop 服务：登录、产品库、素材库、AI 分镜和方案编辑
都在服务器端，客户端只负责界面与本机渲染，**本机不需要安装 Python 运行时**。

本构建未做代码签名，Windows SmartScreen 可能提示「未知发布者」，
选择「更多信息 → 仍要运行」即可。本轮只提供 Windows 版，macOS 与 Linux 暂未发布。

## 1. 客户端

| 系统 | 下载 | 体积 |
|---|---|---|
| Windows 10/11 x64 | [Octop-green-windows-amd64-{{VERSION}}.zip]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-green-windows-amd64-{{VERSION}}.zip) | 5.3 MB |

解压后目录里是两个文件：`Octop.exe`（主程序）和 `README.txt`。

> 只要主程序的话，也可以直接下 [Octop.exe]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop.exe)（12.5 MB），
> 但没有随附的使用说明。

全部发行版本见 [Releases]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases)。

## 2. 视频渲染环境（需要出片时才装）

本版**不附带**本机渲染引擎（Node + Remotion + Chromium，约 228 MB）。
要出片时，在界面「视频环境」页点 **一键安装**，客户端会从服务端下载并装到
程序同级的 `video-runtime/` 子目录。

- 未安装前该页显示「需要安装」，**其余功能完全不受影响**。
- 首次安装需下载约 228 MB，耗时取决于网络。
- 装完后点「重新检测」，显示「本机制作已就绪」即可正式出片。

## 用了什么

- 需要 Microsoft Edge WebView2 Runtime（Windows 11 与多数 Windows 10 已自带）。
- 请把客户端解压到**可写目录**（不要放 `C:\Program Files`）：视频环境安装会写入程序同级目录。
- 视频环境装好后，绿色版目录会多出一个 `video-runtime/` 子目录（约 500 MB）。

## 文档

- 使用文档与部署指南：<https://github.com/TencentCloud/Octop/tree/main/docs>
- API 参考：<https://github.com/TencentCloud/Octop/blob/main/docs/api.md>

## 许可

MIT，见源码仓库。
