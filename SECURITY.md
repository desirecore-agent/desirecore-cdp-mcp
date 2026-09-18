# Security / 安全

This is a developer debugging bridge, not a sandbox. Default tools only inspect windows and DOM, but their results and screenshots can disclose private data. Review the instance and window before sharing them with a remote model.

`--allow-control` explicitly grants keyboard/mouse input, reload and arbitrary main-world JavaScript, potentially including full IPC through `window.conveyor`. It has no built-in per-call approval or takeover indicator. DesireCore runtime Agents must use the governed `ControlDesireCoreGui` instead.

HTTP binds only to 127.0.0.1 and requires a local Bearer token. Never expose raw CDP or disable Host/Origin checks. Run the optional tunnel as a separate process. Keep local tokens and Platform keys separate, out of source control, command history and chat.

A timeout or disconnect means an in-flight side effect may already have happened. Do not automatically retry. Select a new generation after an instance restarts. Registry entries, local lock files and Conveyor probes are discovery hints in a trusted same-user environment, not cryptographic authentication of hostile local software.

报告问题时请使用 GitHub 私密漏洞报告（仓库启用时）或联系仓库维护者，勿公开 token、用户目录、截图或消息正文。报告应提供版本、平台、无敏感信息的复现步骤及影响边界。默认 token 在 POSIX 新建为 0600；Windows 依赖私有用户目录 ACL，请核实权限。
