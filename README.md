# control-browser-cdp

用于 Codex 的浏览器控制技能。通过一个持久的 Chrome DevTools Protocol（CDP）连接控制现有 Chromium 浏览器，并通过本地代理处理多标签页命令、事件订阅与并发请求。

当前版本：**1.2.0**。技能文件来自 `control-browser-cdp-V1.2.0.zip`，发布时保留原始内容。

## 安装

在 Codex 中使用 skill-installer：

```text
$skill-installer 从 https://github.com/chenpengxiao/control-browser-cdp 安装 control-browser-cdp 目录中的技能
```

也可以使用 Codex 自带的安装脚本：

```powershell
python "$env:USERPROFILE/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py" --repo chenpengxiao/control-browser-cdp --path control-browser-cdp
```

安装后，技能将在下一轮对话中可用。安装脚本遇到已有同名目录时会停止；更新前请先备份现有目录。

## 使用条件

- Node.js 22 或更新版本。
- Chrome、Edge、Brave 或 Chromium 已启用远程调试。
- 浏览器首次连接时若显示调试授权提示，需要由用户批准。

## 使用

在 Codex 中调用：

```text
$control-browser-cdp 连接当前浏览器并列出标签页
```

启动代理后，先检查 `status` 中的 `browser.connected`，再用 `list` 确认目标标签页。后续操作复用同一个代理连接。

完整流程见 [SKILL.md](control-browser-cdp/SKILL.md)，命令和故障排查见 [command-reference.md](control-browser-cdp/references/command-reference.md)。

## 文件结构

```text
control-browser-cdp/
├── SKILL.md
├── agents/openai.yaml
├── references/command-reference.md
└── scripts/
    ├── cdp-proxy.mjs
    └── cdp-proxy-selftest.mjs
```

## 自检

```powershell
node control-browser-cdp/scripts/cdp-proxy-selftest.mjs
```

自检使用模拟浏览器连接和本地测试服务，验证连接复用、命令关联、并发处理、取消与事件清理。它不代表已经连接或验证了实际浏览器。

## 本地访问边界

默认使用带随机令牌验证的本地 Unix socket 或 Windows 命名管道。HTTP 接口默认关闭；启用时仅绑定本机回环地址，并使用相同令牌鉴权。浏览器调试端口、代理令牌和 WebSocket 地址应保持在受信任的本地环境中。
