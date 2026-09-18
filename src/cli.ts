import { pathToFileURL } from 'node:url'
import { createTokenFile, defaultTokenFile, parseArgs, prepareHttpToken } from './config.js'
import { InstanceManager } from './manager.js'
import { ToolService } from './tools.js'
import { startHttp, startStdio } from './server.js'

const HELP = `DesireCore CDP → MCP（开发者调试桥接）

启动：desirecore-cdp-mcp --transport http（独立 HTTP 服务）
      desirecore-cdp-mcp（默认 stdio，供 MCP 客户端启动）
      源码安装：npm ci && npm run build，然后 npm start。
      默认自动发现本机多个实例；没有实例也能启动。不启动 DesireCore。

--home <目录>          可选：仅发现一个 home，而非自动枚举全部实例
--cdp-port <端口>      可选：仅连接操作者明确选择的端口，与 --home 互斥
--registry <路径>      可选：使用指定实例名录；默认读取当前用户全局名录
发现：desirecore-cdp-mcp list（或源码目录 npm run instances）
凭据：desirecore-cdp-mcp init-token [--token-file <本机私有路径>]

--transport stdio|http  默认 stdio；HTTP 只绑定 127.0.0.1
--port <端口>          MCP HTTP 端口，默认 9333（不是 CDP 端口）
--token-file <路径>    HTTP token；未指定时读环境变量或自动创建/复用独立的本机 token
--timeout <毫秒>       总调用截止时间，100–60000，默认 15000
--allow-origin <origin> 精确 Origin 白名单，可重复；默认拒绝带 Origin 的请求
--allow-control        开启输入/重载及任意主世界 JavaScript，拥有完整 IPC 权限
--help                 显示本帮助

按需刷新实例；不扫描端口，不自动开启生产 CDP，不启动/关闭 DesireCore，不创建隧道。
stdio 客户端使用 desirecore-cdp-mcp 或 node <安装目录>/bin/desirecore-cdp-mcp.cjs；不需要 tsx。
不要把 npm run 的 banner 接入 MCP stdout。
本工具不是运行时 Agent 的 ControlDesireCoreGui 替代品。控制没有内置逐次审批/接管披露。
`

export async function main(argv: string[]): Promise<void> {
  if (argv.some((arg) => ['--help', '-h'].includes(arg))) {
    process.stdout.write(HELP)
    return
  }
  if (argv[0] === 'list') {
    const config = parseArgs(argv.slice(1))
    const instances = new InstanceManager(config)
    try {
      process.stdout.write(`${JSON.stringify(await instances.list(AbortSignal.timeout(config.timeoutMs)), null, 2)}\n`)
    } finally {
      instances.close()
    }
    return
  }
  if (argv[0] === 'init-token') {
    if (argv.length !== 1 && (argv.length !== 3 || argv[1] !== '--token-file' || !argv[2]))
      throw new Error('用法：init-token --token-file <私有路径>')
    createTokenFile(argv[2] ?? defaultTokenFile())
    console.error('[desirecore-cdp] 已创建独立 token 文件（未输出内容）；Windows 请确认父目录 ACL 仅允许当前用户访问')
    return
  }
  const config = parseArgs(argv)
  // 在接触 CDP 之前先验证本地凭据；缺失凭据时不开放 HTTP。
  const token = config.transport === 'http' ? prepareHttpToken(config) : undefined
  const instances = new InstanceManager(config)
  let closeTransport: (() => Promise<void>) | undefined
  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    instances.close()
    await closeTransport?.()
  }
  try {
    // 不依赖任何 DesireCore 实例在线；第一次工具查询时再发现与连接。
    const service = new ToolService(instances, config)
    if (config.transport === 'http') {
      if (!token) throw new Error('HTTP token 缺失')
      const http = await startHttp(service, config, token)
      closeTransport = http.close
      if (!config.tokenFile && process.env.DESIRECORE_MCP_TOKEN === undefined) {
        console.error(`[desirecore-cdp] 认证文件：${defaultTokenFile()}（不输出密钥）`)
      }
      console.error(
        `[desirecore-cdp] ${http.url}；独立多实例服务已就绪；控制能力：${config.allowControl ? '已开启（高权限）' : '关闭'}；隧道需另行配置`
      )
    } else {
      const server = await startStdio(service)
      closeTransport = () => server.close()
      process.stdin.once('end', () => {
        void shutdown().catch(() => {
          process.exitCode = 1
        })
      })
      console.error(`[desirecore-cdp] stdio 已就绪；控制能力：${config.allowControl ? '已开启（高权限）' : '关闭'}`)
    }
    const stop = (): void => {
      void shutdown().catch(() => {
        process.exitCode = 1
      })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch (error) {
    await shutdown()
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[desirecore-cdp] ${error instanceof Error ? error.message : '启动失败'}`)
    process.exitCode = 1
  })
}
