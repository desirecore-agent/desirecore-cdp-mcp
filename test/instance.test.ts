import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/config.js'
import { discoverInstances, type DiscoveryDeps } from '../src/instance.js'
import { readBoundedText } from '../src/local-state.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dc-mcp-discovery-'))
  roots.push(root)
  const registry = join(root, 'registry.json')
  const config = parseArgs(['--registry', registry], {})
  const identities = new Map<number, string>()
  const deps: DiscoveryDeps = {
    identities: vi.fn(async () => identities),
    endpoint: vi.fn(async (port) => `ws://127.0.0.1:${port}/devtools/browser/fixture-${port}`),
  }
  const homes: string[] = []
  function add(name: string, pid: number, port: number) {
    const home = join(root, name)
    mkdirSync(join(home, 'agent-service.lock'), { recursive: true })
    const lock = {
      pid,
      hostname: hostname(),
      token: `launch-${pid}`,
      startedAt: '2026-09-18T00:00:00Z',
      processStartIdentity: `fixture:${pid}`,
      ...(process.platform === 'linux'
        ? {
            processBootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
            processPidNamespace: readlinkSync('/proc/self/ns/pid'),
          }
        : {}),
    }
    writeFileSync(join(home, 'agent-service.lock', 'meta.json'), JSON.stringify(lock))
    writeFileSync(join(home, 'cdp.port'), String(port))
    identities.set(pid, lock.processStartIdentity)
    homes.push(home)
    writeFileSync(registry, JSON.stringify({ version: 1, instances: homes.map((home) => ({ home })) }))
    return { home, lock }
  }
  const list = () => discoverInstances(config, AbortSignal.timeout(3000), deps)
  return { root, registry, config, identities, deps, homes, add, list }
}

describe('独立文件协议与自动实例发现', () => {
  it('没有名录/实例时返回空列表，不启动应用', async () => {
    const f = fixture()
    expect(await f.list()).toEqual({ instances: [], warnings: [] })
    expect(f.deps.endpoint).not.toHaveBeenCalled()
  })
  it('自动找到多个任意端口并按真实路径去重', async () => {
    const f = fixture()
    const first = f.add('dev', 101, 19001)
    f.add('prod', 102, 38003)
    writeFileSync(
      f.registry,
      JSON.stringify({ version: 1, instances: [...f.homes, first.home].map((home) => ({ home })) })
    )
    const result = await f.list()
    expect(result.instances.map(({ info }) => info.cdpPort)).toEqual([19001, 38003])
    expect(result.instances.every(({ info }) => info.available && /^[a-f0-9]{32}$/.test(info.instanceId!))).toBe(true)
    expect(f.deps.identities).toHaveBeenCalledTimes(1)
  })
  it('死 PID / PID 复用 / 外机锁均不探测陈旧端口', async () => {
    const f = fixture()
    f.add('dead', 201, 19011)
    f.add('reused', 202, 19012)
    const foreign = f.add('foreign', 203, 19013)
    f.identities.delete(201)
    f.identities.set(202, 'fixture:different')
    writeFileSync(
      join(foreign.home, 'agent-service.lock', 'meta.json'),
      JSON.stringify({ ...foreign.lock, hostname: 'other-host' })
    )
    expect((await f.list()).instances.every(({ info }) => !info.available && info.cdpPort === null)).toBe(true)
    expect(f.deps.endpoint).not.toHaveBeenCalled()
  })
  it('运行中增删实例；旧 binding 在代际变化后拒绝，ID 随之更新', async () => {
    const f = fixture()
    const a = f.add('first', 301, 19301)
    const before = (await f.list()).instances[0]
    await before.binding!.assertCurrent()
    f.add('second', 302, 19302)
    expect((await f.list()).instances).toHaveLength(2)
    writeFileSync(
      join(a.home, 'agent-service.lock', 'meta.json'),
      JSON.stringify({ ...a.lock, token: 'new-generation' })
    )
    await expect(before.binding!.assertCurrent()).rejects.toThrow(/身份/)
    expect((await f.list()).instances[0].info.instanceId).not.toBe(before.info.instanceId)
    f.identities.delete(302)
    expect((await f.list()).instances[1].info.available).toBe(false)
  })
  it('端口或 browser endpoint 变化签发新 ID，不复用旧连接', async () => {
    const f = fixture()
    const a = f.add('first', 401, 19401)
    const before = (await f.list()).instances[0]
    writeFileSync(join(a.home, 'cdp.port'), '19402')
    await expect(before.binding!.assertCurrent()).rejects.toThrow(/端口/)
    const after = (await f.list()).instances[0]
    expect(after.info.instanceId).not.toBe(before.info.instanceId)
    f.deps.endpoint = async (port) => `ws://127.0.0.1:${port}/devtools/browser/new`
    expect((await f.list()).instances[0].info.instanceId).not.toBe(after.info.instanceId)
  })
  it('名录损坏或版本不支持有提示，不伪造可用实例', async () => {
    const f = fixture()
    for (const raw of ['{bad', '{"version":2,"instances":[]}']) {
      writeFileSync(f.registry, raw)
      const result = await f.list()
      expect(result.instances).toEqual([])
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })
  it('拒绝超大/特殊元数据；一个坏端口不影响其他实例', async () => {
    const f = fixture()
    const bad = f.add('bad', 501, 19501)
    f.add('good', 502, 19502)
    writeFileSync(join(bad.home, 'cdp.port'), 'x'.repeat(1000))
    const result = await f.list()
    expect(result.instances[0].info.available).toBe(false)
    expect(result.instances[1].info.available).toBe(true)
    expect(() => readBoundedText(f.root)).toThrow(/普通文件/)
  })
  it('显式 home 过滤保留，但默认无需 home', async () => {
    const f = fixture()
    const a = f.add('a', 601, 19601)
    f.add('b', 602, 19602)
    const result = await discoverInstances({ ...f.config, home: a.home }, AbortSignal.timeout(3000), f.deps)
    expect(result.instances).toHaveLength(1)
    expect(result.instances[0].info.cdpPort).toBe(19601)
  })
})
