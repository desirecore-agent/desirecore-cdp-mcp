import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseArgs } from '../src/config.js'
import { discoverInstances, type InstanceInfo } from '../src/instance.js'
import { readProcessIdentities } from '../src/local-state.js'
import { InstanceManager } from '../src/manager.js'
import { ToolService } from '../src/tools.js'
import { startHttp } from '../src/server.js'
import { discoverBrowserEndpoint, isObject } from '../src/cdp.js'
import { startFakeCdp, type FakeCdp } from './fake-cdp.js'

const TOKEN = 'multi-instance-test-'.repeat(4)
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function content(result: unknown): Record<string, unknown> {
  if (!isObject(result) || !Array.isArray(result.content) || typeof result.content[0]?.text !== 'string')
    throw new Error('缺少文本结果')
  return JSON.parse(result.content[0].text)
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dc-mcp-multi-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const registry = join(root, 'registry.json')
  const config = parseArgs(['--registry', registry, '--allow-control', '--timeout', '1000'], {})
  const homes: string[] = []
  const identities = new Map<number, string>()
  const manager = new InstanceManager(config, (signal) =>
    discoverInstances(config, signal, {
      identities: async () => identities,
      endpoint: discoverBrowserEndpoint,
    })
  )
  cleanup.push(() => manager.close())
  const service = new ToolService(manager, config)
  const http = await startHttp(service, { ...config, port: 0 }, TOKEN)
  cleanup.push(http.close)
  const client = new Client({ name: 'multi-test', version: '1' })
  cleanup.push(() => client.close())
  await client.connect(
    new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
  )
  const list = async (): Promise<InstanceInfo[]> =>
    content(await client.callTool({ name: 'desirecore_list_instances' })).instances as InstanceInfo[]
  async function add(label: string) {
    const fake = await startFakeCdp()
    cleanup.push(fake.close)
    const home = join(root, label)
    const pid = 1000 + homes.length
    const signature = `fixture:${pid}`
    identities.set(pid, signature)
    mkdirSync(join(home, 'agent-service.lock'), { recursive: true })
    const lock = {
      pid,
      hostname: hostname(),
      token: label,
      startedAt: '2026-09-18T00:00:00Z',
      processStartIdentity: signature,
      ...(process.platform === 'linux'
        ? {
            processBootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
            processPidNamespace: readlinkSync('/proc/self/ns/pid'),
          }
        : {}),
    }
    writeFileSync(join(home, 'agent-service.lock', 'meta.json'), JSON.stringify(lock))
    writeFileSync(join(home, 'cdp.port'), String(fake.port))
    homes.push(home)
    writeRegistry()
    return { fake, home, pid, lock }
  }
  function writeRegistry() {
    writeFileSync(registry, JSON.stringify({ version: 1, instances: homes.map((home) => ({ home })) }))
  }
  return { root, registry, client, service, list, add, identities, homes, writeRegistry }
}
function writes(fake: FakeCdp) {
  return fake.packets.filter(({ method }) => method === 'Input.insertText')
}

describe('多实例真实 MCP 协议与动态发现', () => {
  it('空闲断线随后名录消失也保留故障代际，不能静默重建连接', async () => {
    const f = await fixture()
    const { fake } = await f.add('idle')
    const [instance] = await f.list()
    await f.client.callTool({ name: 'desirecore_status', arguments: { instanceId: instance.instanceId } })
    for (const socket of fake.sockets) socket.terminate()
    await new Promise((done) => setTimeout(done, 40))
    const homes = f.homes.splice(0)
    f.writeRegistry()
    await f.list()
    f.homes.push(...homes)
    f.writeRegistry()
    expect((await f.list())[0].available).toBe(false)
    const result = await f.client.callTool({
      name: 'desirecore_status',
      arguments: { instanceId: instance.instanceId },
    })
    expect(result.isError).toBe(true)
    expect(fake.connections()).toBe(1)
  })

  it('零实例启动并列工具，新增两个实例无需重启 MCP', async () => {
    const f = await fixture()
    expect((await f.client.listTools()).tools).toHaveLength(6)
    expect(await f.list()).toEqual([])
    expect(content(await f.client.callTool({ name: 'desirecore_status' })).service).toBe('ready')
    const a = await f.add('a')
    const b = await f.add('b')
    expect((await f.list()).map(({ cdpPort }) => cdpPort)).toEqual([a.fake.port, b.fake.port])
    f.identities.delete(a.pid)
    expect((await f.list()).filter(({ available }) => available)).toHaveLength(1)
    expect(content(await f.client.callTool({ name: 'desirecore_status' })).service).toBe('ready')
  })
  it('不同实例相同 targetId 精确路由；漏传/未知实例 ID 不发送操作', async () => {
    const f = await fixture()
    const a = await f.add('a')
    const b = await f.add('b')
    const [first, second] = await f.list()
    for (const args of [{ targetId: 'app-main' }, { instanceId: 'f'.repeat(32), targetId: 'app-main' }]) {
      expect((await f.client.callTool({ name: 'desirecore_screenshot', arguments: args })).isError).toBe(true)
    }
    expect(a.fake.packets).toEqual([])
    expect(b.fake.packets).toEqual([])
    const result = await f.client.callTool({
      name: 'desirecore_cdp',
      arguments: {
        instanceId: second.instanceId,
        targetId: 'app-main',
        method: 'Input.insertText',
        params: { text: 'only-b' },
      },
    })
    expect(result.isError).not.toBe(true)
    expect(writes(a.fake)).toHaveLength(0)
    expect(writes(b.fake)).toHaveLength(1)
    const windows = content(
      await f.client.callTool({ name: 'desirecore_list_windows', arguments: { instanceId: first.instanceId } })
    )
    expect(windows.instanceId).toBe(first.instanceId)
    expect(windows.windows).toHaveLength(2)
  })
  it('实例重启产生新 ID，拒绝旧 ID，新实例可选而服务不重启', async () => {
    const f = await fixture()
    const a = await f.add('a')
    const before = (await f.list())[0]
    await f.client.callTool({ name: 'desirecore_status', arguments: { instanceId: before.instanceId } })
    writeFileSync(join(a.home, 'agent-service.lock', 'meta.json'), JSON.stringify({ ...a.lock, token: 'restarted' }))
    const after = (await f.list())[0]
    expect(after.instanceId).not.toBe(before.instanceId)
    expect(
      (
        await f.client.callTool({
          name: 'desirecore_screenshot',
          arguments: { instanceId: before.instanceId, targetId: 'app-main' },
        })
      ).isError
    ).toBe(true)
    expect(
      (
        await f.client.callTool({
          name: 'desirecore_screenshot',
          arguments: { instanceId: after.instanceId, targetId: 'app-main' },
        })
      ).isError
    ).not.toBe(true)
  })
  it('A 超时不阻断 B；名录暂时消失不能解除 A 的故障代际拒绝', async () => {
    const f = await fixture()
    const a = await f.add('a')
    const b = await f.add('b')
    const [first, second] = await f.list()
    const failed = await f.client.callTool({
      name: 'desirecore_cdp',
      arguments: {
        instanceId: first.instanceId,
        targetId: 'app-main',
        method: 'Input.insertText',
        params: { text: 'stall' },
      },
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('结果未知')
    expect(
      (
        await f.client.callTool({
          name: 'desirecore_screenshot',
          arguments: { instanceId: second.instanceId, targetId: 'app-main' },
        })
      ).isError
    ).not.toBe(true)
    writeFileSync(f.registry, JSON.stringify({ version: 1, instances: [] }))
    await f.list()
    f.writeRegistry()
    expect((await f.list())[0].available).toBe(false)
    expect(
      (
        await f.client.callTool({
          name: 'desirecore_screenshot',
          arguments: { instanceId: first.instanceId, targetId: 'app-main' },
        })
      ).isError
    ).toBe(true)
    expect(a.fake.connections()).toBe(1)
    expect(writes(a.fake)).toHaveLength(1)
    expect(b.fake.packets.some(({ method }) => method === 'Page.captureScreenshot')).toBe(true)
  })
  it('按实例互斥：A 在途时 B 可执行，第二次 A 返回本次未执行', async () => {
    const f = await fixture()
    await f.add('a')
    await f.add('b')
    const [a, b] = await f.list()
    const first = f.service.call('desirecore_cdp', {
      instanceId: a.instanceId,
      targetId: 'app-main',
      method: 'Input.insertText',
      params: { text: 'stall' },
    })
    const again = await f.service.call('desirecore_status', { instanceId: a.instanceId })
    expect(JSON.stringify(again)).toContain('本次未执行')
    expect(
      (await f.service.call('desirecore_screenshot', { instanceId: b.instanceId, targetId: 'app-main' })).isError
    ).not.toBe(true)
    expect((await first).isError).toBe(true)
  })
  it('真实 OS 启动身份查询支持当前平台，不把随机 PID 当存活实例', async () => {
    const result = await readProcessIdentities([process.pid, 2147483647], AbortSignal.timeout(10000))
    expect(result.get(process.pid)).toMatch(new RegExp(`^${process.platform}:`))
    expect(result.has(2147483647)).toBe(false)
  })
  it('stdio 在无实例且工作目录不在仓库时也能初始化', async () => {
    const f = await fixture()
    const client = new Client({ name: 'empty-stdio-test', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve('node_modules/tsx/dist/cli.mjs'),
          '--tsconfig',
          resolve('tsconfig.json'),
          resolve('src/cli.ts'),
          '--registry',
          f.registry,
        ],
        cwd: tmpdir(),
        stderr: 'pipe',
      })
    )
    expect((await client.listTools()).tools).toHaveLength(5)
    expect(content(await client.callTool({ name: 'desirecore_list_instances' })).instances).toEqual([])
  })
})
