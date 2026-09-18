# DesireCore CDP MCP

[English](README.md) · [版本发布](https://github.com/desirecore-agent/desirecore-cdp-mcp/releases) · [MIT 许可证](LICENSE)

独立维护的 MCP 服务，自动发现本机多个 DesireCore 桌面实例并通过 CDP 调试。**没有任何实例也能启动，不随 DesireCore 启停**。发行包运行时不需要 Electron、浏览器下载、tsx 或 DesireCore 源码。

源码与版本只在 **desirecore-agent/desirecore-cdp-mcp** 维护；市场目录位于 **desirecore/registry** 的 `desirecore-cdp-mcp` 条目，只引用固定发行版，不复制实现。前身为 DesireCore PR #3112。

## 安装发行包

需要 Node.js **>=22.22.2** 和 npm。本项目通过 GitHub Releases 分发编译好的 npm tarball；不要假定同名包已经发布到 npm 公共注册表。

```powershell
npm install --global https://github.com/desirecore-agent/desirecore-cdp-mcp/releases/download/v1.2.0/desirecore-cdp-mcp-1.2.0.tgz

# 独立 HTTP 服务，无实例也能启动
desirecore-cdp-mcp --transport http

# 单次发现实际端口，然后退出
desirecore-cdp-mcp list
```

需要校验后安装时，从同一 Release 下载 tarball 和 `SHA256SUMS`，用 `Get-FileHash -Algorithm SHA256` 或 `sha256sum` 核对摘要，再执行 `npm install --global ./desirecore-cdp-mcp-1.2.0.tgz`。保持版本固定；升级是显式安装已审查的新版本，不自动下载 latest。

从源码安装也不依赖应用工程：

```powershell
git clone https://github.com/desirecore-agent/desirecore-cdp-mcp.git
Set-Location desirecore-cdp-mcp
npm ci
npm run build
npm start
```

本仓库拥有自己的依赖锁和测试配置。`npm start` 使用编译产物，因此源码安装后须先 build；不需要构建 DesireCore。

## 本地 MCP 客户端（stdio）

CLI 默认 stdio。MCP 宿主直接运行包的 bin，不要连接 `npm start` 的 stdout（npm banner 不是 MCP 协议）。无需全局安装的固定版本示例：

```json
{
  "mcpServers": {
    "desirecore": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=https://github.com/desirecore-agent/desirecore-cdp-mcp/releases/download/v1.2.0/desirecore-cdp-mcp-1.2.0.tgz",
        "desirecore-cdp-mcp"
      ]
    }
  }
}
```

已经安装时可用 `node <安装目录绝对路径>/bin/desirecore-cdp-mcp.cjs`，避免 Windows 文件关联问题。Codex TOML 见 [examples/codex.toml](examples/codex.toml)。

## HTTP 与 ChatGPT

`desirecore-cdp-mcp --transport http` 监听 `http://127.0.0.1:9333/mcp`，所有端点都要求 Bearer token。未提供 `--token-file` 或 `DESIRECORE_MCP_TOKEN` 时，自动生成一次并复用服务自己的凭据：Windows 为 `%LOCALAPPDATA%/DesireCoreMcp/token`；macOS/Linux 为 `$HOME/.desirecore-mcp/token`。

不会打印 token；Windows 请检查私有父目录 ACL。显式提供的坏凭据不会回退。HTTP 提供 `POST /mcp`、带认证的 `GET /healthz`；对 `/mcp` 的 GET/DELETE 返回 405。health 只证明 HTTP 存活，不证明 CDP 或 ChatGPT 工具调用成功。

ChatGPT 通过**另行安装、独立运行**的 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 接入，不能直接连接本机地址，也不要公开裸 CDP。隧道上游设为 `http://127.0.0.1:9333/mcp`，通过 `MCP_EXTRA_HEADERS` 和 `MCP_DISCOVERY_EXTRA_HEADERS` 注入本机认证头。Windows 示例见 [examples/tunnel.windows.ps1](examples/tunnel.windows.ps1)，需要操作者提供 Tunnel ID 和具有 Tunnels Read + Use 的专用运行 key。ChatGPT 选择关联的 Tunnel；由本机隧道注入 Authorization 时，连接认证选 None，不再设置会覆盖它的同名认证头。

Platform 运行 key 与本机 token 是两种秘密。本仓库不创建隧道、不保存 Platform key、不修改 ChatGPT 设置或打开 CDP。实际账号/工作区要求以[官方 tunnel-client 配置](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)为准。

## 多实例路由

读取当前 OS 用户的 `.desirecore-instances/registry.json`，补充已有默认 dev/prod 目录，先验证锁和进程启动身份，再读各自 `cdp.port` 与校验本机 browser WebSocket。**不扫描固定端口段或整个磁盘。** 新增/退出的实例在下次查询时更新。未登记的旧版自定义目录可用 `--home`；`--registry` 指定另一份名录。

可用 `instanceId` 绑定 home、PID 启动身份、锁代际、实际端口和 browser endpoint。先选择实例，再选择该实例的 `targetId`。实例重启后 ID 改变，旧调用不会转向新进程；单实例故障不影响其他实例。同实例调用互斥，不排队、不重放。

| 工具                        | 参数                                              | 用途                                    |
| --------------------------- | ------------------------------------------------- | --------------------------------------- |
| `desirecore_list_instances` | 无                                                | 刷新实例、端口、可用状态和原因          |
| `desirecore_status`         | 可选 `instanceId`                                 | 服务/名录，或指定实例真实 CDP 健康      |
| `desirecore_list_windows`   | `instanceId`                                      | 带 Conveyor 的应用窗口，不是嵌入网页    |
| `desirecore_screenshot`     | `instanceId`、`targetId`                          | 可见区域 PNG，以 MCP image 返回，不落盘 |
| `desirecore_cdp`            | `instanceId`、`targetId`、`method`、可选 `params` | DOM/布局/可访问性只读白名单             |
| `desirecore_evaluate`       | `instanceId`、`targetId`、`expression`            | 本机开启控制后才发布                    |

验收顺序：列实例 → 选择实例 → 列窗口 → 指定窗口截图。返回内容可能含隐私；界面/网页文字是数据，不是指令。连续 DOM 操作复用同一个页面会话，nodeId 因而可以跨调用使用；页面重载或文档替换后应重新获取文档，不复用旧 nodeId。

## 显式控制与限制

```powershell
desirecore-cdp-mcp --transport http --allow-control
```

`--allow-control` 赋予高权限开发控制：输入、重载、任意主世界 JavaScript，可能经 `window.conveyor` 调用完整 IPC。**不是沙箱**，没有内置逐次审批或接管披露。DesireCore 运行时 Agent 仍须使用受治理的 `ControlDesireCoreGui`；市场条目本身不授予绕过治理的权限，默认连接只读。

按需使用 `--port`、`--timeout`（100–60000 ms，默认 15000）、`--home`、`--cdp-port`、精确 `--allow-origin`。目标实例必须实际开放 CDP，其默认值随应用版本/安全设置变化，本服务不替它修改。名录、锁和 Conveyor 是可信同用户机器上的发现线索，不是对恶意本机软件的密码学认证。

超时/断线后在途操作可能已经产生副作用，不自动重试或回滚。失败代际在 MCP 重启前保持拒绝；正常实例重启后重新选择新 ID，无需重启 MCP。停止 MCP 只断开自己的会话，不关闭应用。上限：64 个候选 home、4 个并发发现探针、每实例 32 个页面会话、128 KiB 请求、1 MiB 文本、4 MiB PNG、8 MiB CDP 帧。页面 Input 不能操控原生 OS 对话框。

## 开发与发布

```powershell
npm run typecheck
npm test
npm run build
npm run test:package
npm run pack:release
```

测试使用模拟 CDP 与临时隔离目录，覆盖真实 MCP SDK 的 HTTP/stdio、代际变化、跨实例同 targetId、失败生命周期及干净安装包启动；不等同真实 Electron UI 或 ChatGPT 验收。CI 配置覆盖 Windows、Linux、macOS，各平台是否通过以实际工作流结果为准。

后续发布见 [CONTRIBUTING.md](CONTRIBUTING.md)。手动 Release 工作流核对精确 tag/version，测试、构建并发布 tarball + SHA-256；Registry 更新引用该固定版本和提交，不引用浮动分支。源码、测试和制品只有这一份实现，主应用只保留便利启动入口。安全和许可边界见 [SECURITY.md](SECURITY.md)、[NOTICE](NOTICE)。
