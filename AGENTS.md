# DesireCore Control 应用开发约定

产品类型是独立应用，消费者是外部智能体；MCP 仅为对外协议。禁止作为内部 MCP 服务上架或在安装时自动注册内部工具。

本仓库独立维护，不导入 DesireCore 源码或假定其目录。MIT 仅涵盖本仓库。
保持中英文 README 同步；命令参数和工具定义以带 description 的 JSON Schema 驱动。
默认只读与 loopback；HTTP 私密数据和控制接口必须认证，公开管理页面只能包含静态内容。运行时 Agent 使用内置 ControlDesireCoreGui，勿借此绕过治理。
实例与窗口必须显式选择；断线/超时不得重放。无实例时 MCP 仍必须可启动。
测试仅限 test/；使用模拟 CDP、独立临时目录与凭据，禁止读取真实用户数据。
验证：npm run typecheck、npm test、npm run build、npm run test:package。
提交前审查 npm pack 文件清单。严禁提交 token、系统名录、日志、用户路径或真实截图。
提交不加 AI 署名；后续变更走 feature 分支 PR，发行版固定 tag + 校验摘要，禁止覆盖已发布附件。
