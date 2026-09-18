# Security / 安全

This is a developer debugging bridge, not a sandbox. Default tools only inspect windows and DOM, but their results and screenshots can disclose private data. Review the instance and window before sharing them with a remote model.

`--allow-control` explicitly grants keyboard/mouse input, reload and arbitrary main-world JavaScript, potentially including full IPC through `window.conveyor`. It has no built-in per-call approval or takeover indicator. DesireCore runtime Agents must use the governed `ControlDesireCoreGui` instead.

HTTP binds only to 127.0.0.1. Instance data, configuration and the outward MCP endpoint require a local Bearer token. Only the static dashboard HTML/JS/CSS are public; they embed no instance data or credentials. Same-origin dashboard requests are accepted but still require authentication. The dashboard never stores tokens or enables control. Never expose raw CDP or disable Host/Origin checks. The official tunnel client runs as a separate process, optionally supervised by this application after explicit opt-in. Keep local tokens and Platform keys separate, out of source control, command history and chat.

This product is an application for external agents, not an internal DesireCore MCP service. Installation never registers internal tools, changes Agent configuration or installs an autostart hook.

A timeout or disconnect means an in-flight side effect may already have happened. Do not automatically retry. Select a new generation after an instance restarts. Registry entries, local lock files and Conveyor probes are discovery hints in a trusted same-user environment, not cryptographic authentication of hostile local software.

## Application-managed tunnels / 应用托管隧道

`/api/tunnel/*` requires a random per-run admin token that is distinct from the outward MCP token. Only exact local same-origin or native requests are accepted; an extra MCP Origin allowlist cannot expand administration. No tunnel-management tools are exposed over MCP. The native executable path is configured only at local application startup, never through HTTP parameters. API keys are used only in a request and the owned child's environment, or read from an operator-selected file; no plaintext-key setting is written. Raw child logs are discarded, not returned as error text.

The supervisor isolates inherited environment and profile selection, fixes the production control plane, local MCP target and main channel, and uses an OS-assigned health port announced in a per-run private file. It never disables TLS verification. Normal shutdown terminates only its own child; abnormal host termination can leave manual cleanup work. A readiness response is not ChatGPT end-to-end proof. Like CDP itself, this is not protection against malicious software with the same OS-user authority; high-privilege evaluation can itself reach local resources through application IPC.

管理 token 不与对外 MCP token 共用，OpenAI key 不进参数或日志；只由本机显式操作开启外部访问。普通关闭清理自有子进程，不能回滚已执行工具，不保证强杀/断电后的零孤儿状态。页面不保存任何浏览器持久凭据。

报告问题时请使用 GitHub 私密漏洞报告（仓库启用时）或联系仓库维护者，勿公开 token、用户目录、截图或消息正文。报告应提供版本、平台、无敏感信息的复现步骤及影响边界。默认 token 在 POSIX 新建为 0600；Windows 依赖私有用户目录 ACL，请核实权限。
