import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTunnelControl } from '../src/tunnel.js'
import { parseArgs } from '../src/config.js'
import { InstanceManager } from '../src/manager.js'
import { ToolService } from '../src/tools.js'
import { startHttp } from '../src/server.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const ID = 'tunnel_' + 'a'.repeat(32)
const KEY = 'sk-test-only-' + 'x'.repeat(48)
const TOKEN = 'mcp-test-only-'.repeat(5)
const fixture = fileURLToPath(new URL('./tunnel-fixture.cjs', import.meta.url))
async function harness(extra: string[] = [], realMissing = false) {
  const root = mkdtempSync(join(tmpdir(), 'dc-tunnel-integration-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const registry = join(root, 'registry.json')
  writeFileSync(registry, '{"version":1,"instances":[]}')
  const config = parseArgs(
    ['--registry', registry, '--transport', 'http', '--allow-origin', 'https://extra.example'],
    {}
  )
  const instances = new InstanceManager(config)
  cleanup.push(() => instances.close())
  const spawned: ChildProcess[] = []
  let environment: NodeJS.ProcessEnv | undefined
  const tunnel = createTunnelControl(
    TOKEN,
    {
      stateDirectory: root,
      clientPath: join(root, 'nonexistent-client'),
      env: {
        ...process.env,
        OPENAI_API_KEY: 'must-not-inherit',
        MCP_SERVER_URL: 'http://evil.example',
        TUNNEL_CLIENT_PROFILE: 'unrelated',
        NODE_OPTIONS: '--invalid',
      },
    },
    realMissing
      ? undefined
      : {
          spawn: (_file: string, args: string[], opts: SpawnOptions) => {
            environment = opts.env
            const child = spawn(process.execPath, [fixture, ...args, ...extra], opts)
            spawned.push(child)
            return child
          },
        }
  )
  cleanup.push(tunnel.close)
  const http = await startHttp(new ToolService(instances, config), { ...config, port: 0 }, TOKEN, tunnel)
  cleanup.push(http.close)
  const origin = new URL(http.url).origin
  const admin = { Authorization: 'Bearer ' + tunnel.token, 'Content-Type': 'application/json', Origin: origin }
  const api = (route: string, body?: unknown, headers = admin) =>
    fetch(origin + '/api/tunnel/' + route, {
      method: route === 'status' ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const client = new Client({ name: 'tunnel-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + TOKEN } },
    })
  )
  cleanup.push(() => client.close())
  return { root, origin, admin, api, tunnel, client, spawned, environment: () => environment }
}
async function eventually<T>(fn: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 8000
  let value: T
  do {
    value = await fn()
    if (predicate(value)) return value
    await new Promise((r) => setTimeout(r, 30))
  } while (Date.now() < end)
  throw new Error('等待本地测试状态超时：' + JSON.stringify(value))
}

describe('应用 → 受管隧道进程 → 实际 MCP HTTP', () => {
  it('零实例可启动应用但不自动启动隧道；外部工具定义保持不变', async () => {
    const h = await harness()
    expect(h.spawned).toHaveLength(0)
    expect((await (await h.api('status')).json()).state).toBe('stopped')
    const tools = (await h.client.listTools()).tools
    expect(tools).toHaveLength(5)
    expect(tools.some((t) => /tunnel/.test(t.name))).toBe(false)
    expect((await h.client.callTool({ name: 'desirecore_list_instances' })).isError).not.toBe(true)
  })
  it('MCP token 无法启停或查询隧道，admin 不能访问 MCP；不能放宽 Origin 或注入命令', async () => {
    const h = await harness()
    for (const route of ['status', 'start', 'stop'])
      expect(
        (
          await h.api(route, route === 'start' ? { tunnelId: ID, apiKey: KEY } : undefined, {
            ...h.admin,
            Authorization: 'Bearer ' + TOKEN,
          })
        ).status
      ).toBe(401)
    expect((await fetch(h.origin + '/mcp', { method: 'POST', headers: h.admin, body: '{}' })).status).toBe(401)
    expect(
      (await h.api('start', { tunnelId: ID, apiKey: KEY }, { ...h.admin, Origin: 'https://extra.example' })).status
    ).toBe(403)
    expect((await h.api('start', { tunnelId: ID, apiKey: KEY, clientPath: process.execPath })).status).toBe(400)
    expect(h.spawned).toHaveLength(0)
  })
  it('真实子进程完成初始化和 tools/list；动态就绪端口、密钥隔离及不泄露日志', async () => {
    const h = await harness()
    const response = await h.api('start', { tunnelId: ID, apiKey: KEY })
    expect(response.status).toBe(200)
    expect((await response.json()).ready).toBeNull()
    const status = await eventually(
      () => h.tunnel.manager.status(),
      (s) => s.ready === true
    )
    expect(status.chatgptVerified).toBe(false)
    const evidence = await (await fetch(status.healthUrl + '/evidence')).json()
    expect(evidence.protocolOkay).toBe(true)
    expect(evidence.names).toContain('desirecore_list_instances')
    expect(evidence.mcpUrl).toBe(h.origin + '/mcp')
    expect(evidence.discoveryMatches).toBe(true)
    expect(evidence.keyInArgv).toBe(false)
    expect(evidence.args).toContain('main')
    expect(evidence.config).not.toContain(KEY)
    expect(h.environment()?.OPENAI_API_KEY).toBeUndefined()
    expect(Object.values(h.environment()!)).not.toContain(h.tunnel.token)
    for (const value of [
      JSON.stringify(status),
      await (await h.api('status')).text(),
      await (await fetch(h.origin)).text(),
      await (await fetch(h.origin + '/app.js')).text(),
    ]) {
      expect(value).not.toContain(KEY)
      expect(value).not.toContain(TOKEN)
      expect(value).not.toContain(h.tunnel.token)
    }
    expect((await h.api('stop')).status).toBe(200)
    expect((await h.tunnel.manager.status()).state).toBe('stopped')
    expect((await h.client.listTools()).tools).toHaveLength(5)
  })
  it('运行但未就绪不伪报成功；并发启动只产生一条隧道', async () => {
    const h = await harness(['--fixture-never-ready'])
    const results = await Promise.all([
      h.api('start', { tunnelId: ID, apiKey: KEY }),
      h.api('start', { tunnelId: ID, apiKey: KEY }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    expect(h.spawned).toHaveLength(1)
    const status = await eventually(
      () => h.tunnel.manager.status(),
      (s) => s.ready === false
    )
    expect(status.state).toBe('running')
  })
  it('客户端缺失不退出应用，也不输出 API key；允许操作者修正后再试', async () => {
    const h = await harness([], true)
    expect((await h.api('start', { tunnelId: ID, apiKey: KEY })).status).toBe(400)
    const status = await eventually(
      () => h.tunnel.manager.status(),
      (s) => s.state === 'error' && s.pid === undefined
    )
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect((await h.client.listTools()).tools).toHaveLength(5)
  })
  it('子进程异常退出保持 error，不自动重启；显式再启动才创建新进程', async () => {
    const h = await harness()
    await h.api('start', { tunnelId: ID, apiKey: KEY })
    const status = await eventually(
      () => h.tunnel.manager.status(),
      (s) => s.ready === true
    )
    await fetch(status.healthUrl + '/crash')
    await eventually(
      () => h.tunnel.manager.status(),
      (s) => s.state === 'error' && s.pid === undefined
    )
    expect(h.spawned).toHaveLength(1)
    expect((await h.client.listTools()).tools).toHaveLength(5)
    expect((await h.api('start', { tunnelId: ID, apiKey: KEY })).status).toBe(200)
    expect(h.spawned).toHaveLength(2)
  })
  it('启动与关闭重叠时取消启动并回收子进程，不留下可再次启动的管理器', async () => {
    const h = await harness()
    const starting = h.tunnel.manager.start({ tunnelId: ID, apiKey: KEY }).catch(() => undefined)
    const closing = h.tunnel.close()
    await Promise.all([starting, closing])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].exitCode !== null || h.spawned[0].signalCode !== null).toBe(true)
    expect(existsSync(h.tunnel.tokenFile)).toBe(false)
    await expect(h.tunnel.manager.start({ tunnelId: ID, apiKey: KEY })).rejects.toThrow(/退出/)
  })
  it('应用关闭清理自己的子进程与管理凭据，未启动的兄弟应用不受影响', async () => {
    const a = await harness(),
      b = await harness()
    await a.api('start', { tunnelId: ID, apiKey: KEY })
    await eventually(
      () => a.tunnel.manager.status(),
      (s) => s.ready === true
    )
    await a.tunnel.close()
    expect(a.spawned[0].exitCode !== null || a.spawned[0].signalCode !== null).toBe(true)
    expect(existsSync(a.tunnel.tokenFile)).toBe(false)
    expect(existsSync(b.tunnel.tokenFile)).toBe(true)
    expect((await b.client.listTools()).tools).toHaveLength(5)
  })
})
