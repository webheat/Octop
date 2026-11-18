@echo off
rem 解除 Windows 的"来自互联网"标记（Mark of the Web）。
rem
rem 从网上下载的 zip 解压后，里面的文件可能仍带 Zone.Identifier 标记，
rem 双击 exe 时 Windows 会弹出"Windows 已保护你的电脑"而拒绝运行。
rem 运行本脚本即可批量清除该标记，然后正常双击 Octop.exe。
rem
rem 其它等效做法：
rem   1) 右键 zip 文件 -> 属性 -> 勾选"解除锁定" -> 确定 -> 重新解压
rem   2) 右键 exe -> 属性 -> 勾选"解除锁定" -> 确定
rem
rem 本脚本只清除安全标记，不修改任何程序文件。

chcp 65001 >nul
echo [octop] 正在解除下载标记...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue"
echo [octop] 完成。现在可以双击 Octop.exe 启动。
echo.
pause
