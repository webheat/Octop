# Octop 客户端下载

Octop 是一个开源自托管的 AI 助手平台：多用户、多智能体，单进程部署，不需要额外的
队列或中间件。本仓库用于分发 **Octop 桌面客户端** 的发行产物。

> 源码不在本仓库。源码见 [GitHub](https://github.com/TencentCloud/Octop) /
> [CNB](https://cnb.cool/mengxa.com/Octop)，本仓库只放下载页与 Release 产物。

## 装两步就能用

1. **装客户端**（Windows，约 6 MB）
2. **装视频制作组件**（约 71 MB）—— 视频在本机渲染，不装无法出片

客户端连接我们已部署好的 Octop 服务：登录、产品库、AI 分镜和方案确认都在服务器端，
客户端只负责界面与本机渲染，**本机不需要安装 Python 运行时**。

本构建未做代码签名，Windows SmartScreen 可能提示「未知发布者」，
选择「更多信息 → 仍要运行」即可。本轮只提供 Windows 版，macOS 与 Linux 暂未发布。

## 1. 客户端

| 系统 | 下载 | 体积 |
|---|---|---|
| Windows 10/11 x64 | [Octop-desktop-windows-amd64-{{VERSION}}.exe]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-desktop-windows-amd64-{{VERSION}}.exe) | ~6 MB |
| Windows on ARM（骁龙本等） | [Octop-desktop-windows-arm64-{{VERSION}}.exe]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-desktop-windows-arm64-{{VERSION}}.exe) | ~5.5 MB |

全部发行版本见 [Releases]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases)。
远程版打开后直连 <https://ocbot.aixifs.com/videogen>。

## 2. 视频制作组件（必装）

桌面客户端**不自带**视频渲染环境（Node + Remotion + 浏览器，解包后约 500 MB），
需要单独装一次。不装不影响登录、产品库和方案编辑，只是无法在本机出片。

| 组件 | 体积 | 下载 |
|---|---|---|
| **视频制作组件（Windows x64）** | ~71 MB | [下载]({{GITEE_WEB}}/{{OWNER}}/{{REPO}}/releases/download/{{TAG}}/Octop-video-components-windows-x64-{{VERSION}}.exe) |

安装步骤：

1. 运行上面的组件安装包，全部用默认选项（装到 `%LOCALAPPDATA%\Octop\video-runtime`，
   不写系统 PATH、不需要管理员权限）。
2. 回到客户端「制作产品视频」页面，点 **重新检测**。
3. 客户端会跑一段几秒的本机测试视频，显示「本机制作已就绪」即可正式出片。

客户端里也有同样的下载按钮，地址取不到时才提示联系管理员。

## 要自己跑一套服务？

本页只放远程版客户端。自带 Python 运行时的本地版安装包体积 200 MB 起，
超过 Gitee 单附件 100 MB 的上限，因此不在本仓库分发。
需要离线或私有部署时，按源码仓库的部署文档自行安装即可。

## 文档

- 使用文档与部署指南：<https://github.com/TencentCloud/Octop/tree/main/docs>
- API 参考：<https://github.com/TencentCloud/Octop/blob/main/docs/api.md>

## 许可

MIT，见源码仓库。
