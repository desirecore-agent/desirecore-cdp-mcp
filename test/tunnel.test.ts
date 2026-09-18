import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Script } from 'node:vm'
import { createTunnelControl, tunnelEnvironment, validateHealthUrl } from '../src/tunnel.js'
import { TunnelSupervisor } from '../src/tunnel.js'
import { parseArgs } from '../src/config.js'
import { TUNNEL_JS, TUNNEL_HTML } from '../src/tunnel-ui.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function control(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dc-tunnel-unit-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const c = createTunnelControl('m'.repeat(64), { stateDirectory: root, env: {}, ...options })
  cleanup.push(c.close)
  c.manager.bindMcpUrl('http://127.0.0.1:9333/mcp')
  return { ...c, root }
}
const ID = 'tunnel_' + '1'.repeat(32)
const KEY = 'sk-fixture-' + 'x'.repeat(50)

describe('官方 ChatGPT 隧道配置与凭据', () => {
  it('普通启动不因环境存在 key/ID 而自动开放隧道', () => {
    expect(
      parseArgs(['--transport', 'http'], { CONTROL_PLANE_API_KEY: KEY, CONTROL_PLANE_TUNNEL_ID: ID }).chatgptTunnel
    ).toBeUndefined()
  })
  it('显式启动可读取环境 ID，命令行 ID 优先', () => {
    expect(parseArgs(['--transport', 'http', '--chatgpt-tunnel'], { CONTROL_PLANE_TUNNEL_ID: ID }).tunnelId).toBe(ID)
    const other = 'tunnel_' + '2'.repeat(32)
    expect(
      parseArgs(['--transport', 'http', '--chatgpt-tunnel', '--tunnel-id', other], { CONTROL_PLANE_TUNNEL_ID: ID })
        .tunnelId
    ).toBe(other)
  })
  it('拒绝缺 ID、非法 ID、stdio 隧道与 shell shim', () => {
    for (const args of [
      ['--transport', 'http', '--chatgpt-tunnel'],
      ['--transport', 'http', '--tunnel-id', 'wrong'],
      ['--chatgpt-tunnel', '--tunnel-id', ID],
      ['--transport', 'http', '--tunnel-client', 'x.cmd'],
    ])
      expect(() => parseArgs(args, {})).toThrow()
  })
  it('隔离 admin-token，不复用 MCP token，并只清理本次凭据', async () => {
    const c = control()
    expect(c.token).not.toBe('m'.repeat(64))
    expect(readFileSync(c.tokenFile, 'utf8').trim()).toBe(c.token)
    const other = join(c.root, 'unrelated')
    writeFileSync(other, 'preserve')
    await c.close()
    expect(existsSync(c.tokenFile)).toBe(false)
    expect(readFileSync(other, 'utf8')).toBe('preserve')
  })
  it('只继承必要环境并注入专用密钥与同源认证，排除其他 tunnel/profile/keys', () => {
    const env = tunnelEnvironment(
      {
        PATH: 'tool-path',
        HOME: '/tmp/example',
        CONTROL_PLANE_BASE_URL: 'https://evil.example',
        CONTROL_PLANE_API_KEY: 'other',
        OPENAI_API_KEY: 'other',
        TUNNEL_CLIENT_PROFILE: 'other',
        MCP_SERVER_URL: 'http://elsewhere',
        HARPOON_ENABLED: 'true',
        CLOUDFLARED_TOKEN: 'other',
        NODE_OPTIONS: '--bad',
        NO_PROXY: 'corp.local',
      },
      KEY,
      'm'.repeat(64)
    )
    expect(env.DESIRECORE_TUNNEL_API_KEY).toBe(KEY)
    expect(env.DESIRECORE_TUNNEL_MCP_AUTH).toBe('Bearer ' + 'm'.repeat(64))
    expect(env.MCP_DISCOVERY_EXTRA_HEADERS).toBe(env.MCP_EXTRA_HEADERS)
    expect(env.NO_PROXY).toContain('127.0.0.1')
    for (const name of [
      'CONTROL_PLANE_BASE_URL',
      'CONTROL_PLANE_API_KEY',
      'OPENAI_API_KEY',
      'TUNNEL_CLIENT_PROFILE',
      'MCP_SERVER_URL',
      'HARPOON_ENABLED',
      'CLOUDFLARED_TOKEN',
      'NODE_OPTIONS',
    ])
      expect(env[name]).toBeUndefined()
  })
  it.each([
    'http://evil.example:1',
    'https://127.0.0.1:1',
    'http://u:p@127.0.0.1:1',
    'http://127.0.0.1:1/path',
    'http://127.0.0.1:1?secret=x',
    'http://127.0.0.1',
  ])('拒绝不安全 health URL %s', (url) => expect(() => validateHealthUrl(url)).toThrow())
  it('接受官方动态 loopback health URL', () =>
    expect(validateHealthUrl('http://127.0.0.1:12345\n')).toBe('http://127.0.0.1:12345'))
  it('参数错误和无 key 时不启动；不能通过请求选择可执行文件或本机 URL', async () => {
    const c = control()
    for (const input of [
      {},
      { tunnelId: ID, clientPath: process.execPath },
      { tunnelId: ID, mcpUrl: 'http://evil.example' },
      { tunnelId: ID, apiKey: 'bad\nheader' },
      { tunnelId: ID },
    ])
      await expect(c.manager.start(input)).rejects.toThrow()
    expect((await c.manager.status()).pid).toBeUndefined()
  })
  it('坏 key 文件不回落到环境中的合法 key', async () => {
    const c = control({ apiKeyFile: join(tmpdir(), 'nonexistent-tunnel-key'), env: { CONTROL_PLANE_API_KEY: KEY } })
    await expect(c.manager.start({ tunnelId: ID })).rejects.toThrow(/不会回落/)
  })
  it('关闭后不能再次启动，也不能重新绑定 MCP', async () => {
    const c = control()
    expect(() => c.manager.bindMcpUrl('http://127.0.0.1:9444/mcp')).toThrow()
    await c.close()
    await expect(c.manager.start({ tunnelId: ID, apiKey: KEY })).rejects.toThrow(/退出/)
  })
  it('底层 spawn 的原始错误和环境中的 key 不进入状态或 HTTP 错误', async () => {
    const c = control()
    const supervisor = new TunnelSupervisor(
      'm'.repeat(64),
      { stateDirectory: c.root, env: { CONTROL_PLANE_API_KEY: KEY } },
      {
        spawn: () => {
          throw new Error('unsafe diagnostic ' + KEY)
        },
      }
    )
    cleanup.push(() => supervisor.close())
    supervisor.bindMcpUrl('http://127.0.0.1:9333/mcp')
    await expect(supervisor.start({ tunnelId: ID })).rejects.not.toThrow(KEY)
    expect(JSON.stringify(await supervisor.status())).not.toContain(KEY)
  })
  it('管理页面脚本语法有效且不持久保存密钥，不渲染不可信 HTML', () => {
    expect(() => new Script(TUNNEL_JS)).not.toThrow()
    expect(TUNNEL_JS).not.toMatch(/localStorage|sessionStorage|innerHTML|clipboard/)
    expect(TUNNEL_JS).toContain("el('tunnel-key').value = ''")
    expect(TUNNEL_HTML).toContain('admin-token')
    expect(TUNNEL_HTML).not.toContain(KEY)
  })
})
