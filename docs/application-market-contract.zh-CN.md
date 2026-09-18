# 应用市场接入契约

DesireCore Control 的产品类别是应用，应用 ID 为 `desirecore-control`；源码仓库与 npm 包名保留 `desirecore-cdp-mcp` 以维持已发布地址兼容。MCP 仅是对外通信协议。

## 责任边界

- 人类从应用市场发现、安装、独立启动或停止本应用；本机管理页面位于应用 HTTP 根路径。
- ChatGPT、Codex 等外部智能体连接应用的 `/mcp`，再选择目标实例和窗口。
- 本应用不随任何 DesireCore 实例启停，不安装自启动项，不修改内部智能体配置，不向 DesireCore 注册 MCP 服务，也不派生服务。
- 用户可以独立更新、卸载本应用；不要删除被控制的 DesireCore home 或本机实例名录。卸载凭据须由用户明确选择。

## 平台准入缺口

检查现有 Registry 4.0.0 和 DesireCore 目录/安装代码时，原生应用链路尚不存在：legacy 应用只接受 `docker-app`；应用安装方法只接受 Docker；应用投影和生命周期收据同样以 Docker 类型判断。直接把 sidecar 改为 app、但保留 MCP manifest，会在一致性验证失败或错误注册内部服务。把它伪装为 Docker 应用也不成立：容器的 loopback 不等同宿主机的 CDP。

因此原来的未发布 MCP 条目已撤回。当前应用发行包可独立安装使用，但尚未在应用市场上架。以下是平台适配的验收条件，而不是对已有能力的声明：

1. 为 `native-app` 提供完整的目录 Schema、StoreApp 投影与平台/Node 运行要求；旧客户端必须清楚提示不支持，不能降格成 MCP。
2. 固定 Release/ref/SHA-256 安装依据，区分安装事实和运行状态；生命周期归类为 app，支持安装、显式启动、停止、升级、卸载及失败恢复。
3. 应用管理页面只能打开经过验证的本机入口，不将 `/mcp` 当作人类 UI，也不派生内部 Service 或 Skill。
4. 应用安装/卸载/重启不改任何 DesireCore 实例及其数据，自动发现仅发生于本应用的只读查询。
5. 验证零实例启动、多实例隔离、拒绝旧运行代际、没有内部 MCP/工具注册、没有跟随 DesireCore 启停；Windows/macOS/Linux 分别验收。

在这些条件完成前，不把候选清单写入生产 Registry，也不把成功发布 GitHub Release 宣称为市场安装链路已完成。
