import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { applicationSchema, APPLICATION } from '../src/application.js'
import { APPLICATION_JS } from '../src/application-ui.js'
import { parseArgs } from '../src/config.js'
import { InstanceManager } from '../src/manager.js'
import { ToolService } from '../src/tools.js'
import { startHttp } from '../src/server.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const TOKEN = 'application-test-only-'.repeat(3)
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'dc-control-app-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const registry = join(dir, 'registry.json')
  writeFileSync(registry, JSON.stringify({ version: 1, instances: [] }))
  const config = parseArgs(['--registry', registry, '--transport', 'http'], {})
  const instances = new InstanceManager(config)
  cleanup.push(() => instances.close())
  const http = await startHttp(new ToolService(instances, config), { ...config, port: 0 }, TOKEN)
  cleanup.push(http.close)
  return { origin: new URL(http.url).origin, headers: { Authorization: `Bearer ${TOKEN}` } }
}
describe('独立应用与外部控制边界', () => {
  it('应用声明不能改成内部服务或随 DesireCore 自动启动', () => {
    const validate = new Ajv().compile(applicationSchema)
    expect(validate(APPLICATION)).toBe(true)
    for (const patch of [
      { kind: 'service' },
      { autoStart: true },
      { registerInternalMcp: true },
      { audience: 'internal-agents' },
    ]) {
      expect(validate({ ...APPLICATION, ...patch })).toBe(false)
    }
  })
  it('公开管理页不泄露 token、实例数据或内联执行代码', async () => {
    const { origin } = await start()
    const response = await fetch(origin)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('DesireCore Control')
    expect(html).not.toContain(TOKEN)
    expect(html).not.toContain('instanceId:')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline')
    expect((await fetch(`${origin}/app.js`)).status).toBe(200)
    expect((await fetch(`${origin}/app.css`)).status).toBe(200)
  })
  it('实例、健康检查与对外 MCP 仍要求独立认证', async () => {
    const { origin } = await start()
    for (const path of ['/api/overview', '/healthz', '/mcp']) expect((await fetch(origin + path)).status).toBe(401)
  })
  it('本机同源管理界面可读取零实例状态，不注册内部服务', async () => {
    const { origin, headers } = await start()
    const response = await fetch(`${origin}/api/overview`, { headers: { ...headers, Origin: origin } })
    const data = await response.json()
    expect(response.status).toBe(200)
    expect(data.instances).toEqual([])
    expect(data.application).toMatchObject({ kind: 'app', registerInternalMcp: false, audience: 'external-agents' })
    expect(data.allowControl).toBe(false)
    expect(data.mcpUrl).toBe(`${origin}/mcp`)
    expect(JSON.stringify(data)).not.toContain(TOKEN)
  })
  it('恶意 Origin 与浏览器请求不能开启控制', async () => {
    const { origin, headers } = await start()
    expect((await fetch(origin, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect(
      (await fetch(`${origin}/api/overview`, { method: 'POST', headers, body: '{"allowControl":true}' })).status
    ).toBe(405)
    expect((await fetch(`${origin}/api/overview?allowControl=true`, { headers })).status).toBe(404)
    expect((await (await fetch(`${origin}/api/overview`, { headers })).json()).allowControl).toBe(false)
  })
  it('页面把实例内容当文本，不持久化 token；应用 bin 不是 stdio 默认入口', () => {
    expect(APPLICATION_JS).not.toMatch(/innerHTML|localStorage|sessionStorage|eval\(/)
    expect(APPLICATION_JS).toContain('textContent')
    const bin = readFileSync(new URL('../bin/desirecore-control.cjs', import.meta.url), 'utf8')
    expect(bin).toContain("['--transport', 'http', ...args]")
  })
})
