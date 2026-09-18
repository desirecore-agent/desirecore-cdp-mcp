import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTokenFile, parseArgs, requireToken, validateConfig } from '../src/config.js'
import { browserEndpoint } from '../src/cdp.js'
import { authorized } from '../src/server.js'
import { toolDefinitions } from '../src/tools.js'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const config = (): ReturnType<typeof parseArgs> => parseArgs(['--cdp-port', '9229'], {})

describe('本机配置与权限', () => {
  it('无需实例参数即可启动自动发现模式', () => {
    expect(parseArgs([], {})).toMatchObject({ transport: 'stdio', allowControl: false })
    expect(parseArgs([], {}).home).toBeUndefined()
    expect(parseArgs([], {}).cdpPort).toBeUndefined()
  })
  it('默认 stdio、禁用控制能力、拒绝有 Origin 的请求', () => {
    expect(config()).toMatchObject({ transport: 'stdio', port: 9333, allowControl: false, allowedOrigins: [] })
  })
  it('继承实例环境不缩成单实例；显式名录覆盖走绝对路径', () => {
    expect(parseArgs([], { DESIRECORE_HOME: 'test-home' }).home).toBeUndefined()
    expect(isAbsolute(parseArgs(['--registry', 'test-registry.json'], {}).registryPath!)).toBe(true)
    expect(isAbsolute(parseArgs([], { DESIRECORE_INSTANCES_REGISTRY_PATH: 'test.json' }).registryPath!)).toBe(true)
  })
  it.each(['0', '65536', 'NaN', '1.2', '-1'])('拒绝非法 CDP 端口 %s', (port) =>
    expect(() => parseArgs(['--cdp-port', port], {})).toThrow()
  )
  it('home 与端口互斥', () => expect(() => parseArgs(['--home', '.', '--cdp-port', '9222'], {})).toThrow())
  it.each([['--cdp-port'], ['--bogus', 'x'], ['--cdp-port', '9222', '--cdp-port', '9223']])(
    '拒绝未知、缺值或重复参数 %j',
    (...args) => expect(() => parseArgs(args, {})).toThrow()
  )
  it.each([
    'null',
    '*',
    'https://example.com/',
    'https://u:p@example.com',
    'https://example.com/a',
    'https://example.com?x=1',
  ])('拒绝非精确 Origin %s', (origin) => {
    expect(() => parseArgs(['--cdp-port', '9222', '--allow-origin', origin], {})).toThrow()
  })
  it('接受显式控制开关与多个精确 Origin', () => {
    expect(
      parseArgs(
        [
          '--cdp-port',
          '9222',
          '--allow-control',
          '--allow-origin',
          'https://example.com',
          '--allow-origin',
          'http://localhost:4000',
        ],
        {}
      ).allowControl
    ).toBe(true)
  })
  it('拒绝配置中的未知字段', () => expect(() => validateConfig({ ...config(), host: '0.0.0.0' })).toThrow())
  it('HTTP token 必填且不接受短密钥', () => {
    expect(() => requireToken(config(), {})).toThrow()
    expect(() => requireToken(config(), { DESIRECORE_MCP_TOKEN: 'short' })).toThrow()
  })
  it('生成独立凭据；不覆盖已有文件；显式坏文件不回落 env', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-mcp-token-'))
    temporary.push(root)
    const tokenFile = join(root, 'private', 'token')
    createTokenFile(tokenFile)
    const raw = readFileSync(tokenFile, 'utf8')
    expect(raw.trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(requireToken({ ...config(), tokenFile }, {})).toBe(raw.trim())
    expect(() => createTokenFile(tokenFile)).toThrow()
    expect(readFileSync(tokenFile, 'utf8')).toBe(raw)
    writeFileSync(tokenFile, '')
    expect(() => requireToken({ ...config(), tokenFile }, { DESIRECORE_MCP_TOKEN: 'x'.repeat(64) })).toThrow()
  })
  it('Bearer 比较拒绝错 token、换行与错误 scheme', () => {
    const token = 'x'.repeat(64)
    expect(authorized(`Bearer ${token}`, token)).toBe(true)
    for (const header of [undefined, `Basic ${token}`, `Bearer ${'y'.repeat(64)}`, `Bearer ${token}\n`])
      expect(authorized(header, token)).toBe(false)
  })
  it('控制能力关闭时，schema 和工具发现都不暴露执行入口', () => {
    const readOnly = toolDefinitions(false)
    expect(readOnly.map((tool) => tool.name)).not.toContain('desirecore_evaluate')
    expect(JSON.stringify(readOnly)).not.toContain('Input.insertText')
    expect(readOnly.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
    const control = toolDefinitions(true)
    expect(control.find((tool) => tool.name === 'desirecore_evaluate')?.annotations?.readOnlyHint).toBe(false)
    expect(control.find((tool) => tool.name === 'desirecore_cdp')?.annotations?.destructiveHint).toBe(true)
  })
})

describe('实例身份与 endpoint 边界', () => {
  it.each([
    'ws://example.com:9229/devtools/browser/a',
    'ws://127.0.0.1:9330/devtools/browser/a',
    'ws://u:p@127.0.0.1:9229/devtools/browser/a',
    'ws://127.0.0.1:9229/devtools/page/a',
    'ws://127.0.0.1:9229/devtools/browser/a?token=x',
    'wss://127.0.0.1:9229/devtools/browser/a',
  ])('拒绝发现响应重定向到 %s', (url) => expect(() => browserEndpoint(url, 9229)).toThrow())
  it('localhost endpoint 固定拨号 loopback，不依赖 DNS', () => {
    expect(browserEndpoint('ws://localhost:9229/devtools/browser/id-1', 9229)).toBe(
      'ws://127.0.0.1:9229/devtools/browser/id-1'
    )
  })
})
