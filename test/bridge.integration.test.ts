import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isObject, type JsonObject } from '../src/cdp.js'
import { parseArgs } from '../src/config.js'
import { ToolService } from '../src/tools.js'
import { InstanceManager } from '../src/manager.js'
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { MAX_REQUEST_BYTES, startHttp } from '../src/server.js'
import { PNG, startFakeCdp } from './fake-cdp.js'

const TOKEN = 'test-only-'.repeat(8)
const closeables: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close()
})

function body(result: unknown): JsonObject {
  if (
    !isObject(result) ||
    !Array.isArray(result.content) ||
    !isObject(result.content[0]) ||
    typeof result.content[0].text !== 'string'
  )
    throw new Error('没有文本结果')
  const parsed: unknown = JSON.parse(result.content[0].text)
  if (!isObject(parsed)) throw new Error('结果不是对象')
  return parsed
}

async function harness(control = false, timeout = 2000) {
  const fake = await startFakeCdp()
  closeables.push(fake.close)
  const config = parseArgs(
    ['--cdp-port', String(fake.port), '--timeout', String(timeout), ...(control ? ['--allow-control'] : [])],
    {}
  )
  const instanceId = 'a'.repeat(32)
  const manager = new InstanceManager(config, async () => ({
    warnings: [],
    instances: [
      {
        info: { instanceId, label: 'fixture', cdpPort: fake.port, available: true },
        binding: { port: fake.port, assertCurrent: () => undefined },
      },
    ],
  }))
  closeables.push(() => manager.close())
  const bridge = await manager.withInstance(instanceId, AbortSignal.timeout(timeout), async (value) => value)
  const service = new ToolService(manager, config)
  // 测试使用 OS 分配的独立端口，不接触运行中的 DesireCore。
  const http = await startHttp(service, { ...config, port: 0 }, TOKEN)
  closeables.push(http.close)
  const connect = async () => {
    const client = new Client({ name: 'bridge-test', version: '1.0.0' })
    closeables.push(() => client.close())
    await client.connect(
      new StreamableHTTPClientTransport(new URL(http.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      })
    )
    // 单实例协议回归显式附上 fixture ID；多实例测试直接使用原始 SDK 客户端。
    return {
      listTools: () => client.listTools(),
      callTool: (params: CallToolRequest['params']) =>
        client.callTool({
          ...params,
          arguments: { instanceId, ...params.arguments },
        }),
    }
  }
  const client = await connect()
  return {
    fake,
    config,
    bridge,
    http,
    client,
    connect,
    service: {
      call: (name: string, args: JsonObject) => service.call(name, { instanceId, ...args }),
    },
  }
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

describe('真实 SDK ↔ HTTP MCP ↔ 模拟 CDP', () => {
  it('初始化、列工具、读取实例状态与多个窗口', async () => {
    const { client, fake } = await harness()
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'desirecore_list_instances',
      'desirecore_status',
      'desirecore_list_windows',
      'desirecore_screenshot',
      'desirecore_cdp',
    ])
    expect(body(await client.callTool({ name: 'desirecore_status' })).connected).toBe(true)
    const windows = body(await client.callTool({ name: 'desirecore_list_windows' })).windows
    expect(windows).toEqual([
      { targetId: 'app-main', title: 'DesireCore', url: 'http://localhost:5173/' },
      { targetId: 'app-chat', title: 'Conversation', url: 'http://localhost:5173/?window=conversation' },
    ])
    expect(fake.origins).toEqual([undefined])
  })
  it('截图返回 MCP 原生 image，CDP attach 到明确窗口', async () => {
    const { client, fake } = await harness()
    const result = await client.callTool({ name: 'desirecore_screenshot', arguments: { targetId: 'app-chat' } })
    expect(result.content).toEqual([{ type: 'image', data: PNG, mimeType: 'image/png' }])
    expect(fake.packets.find((packet) => packet.method === 'Page.captureScreenshot')?.sessionId).toBe(
      'session-app-chat'
    )
    expect(fake.packets.some((packet) => packet.method === 'Target.detachFromTarget')).toBe(false)
  })
  it('连续 DOM 查询保留同一页面会话与 nodeId，不因单次调用结束而失效', async () => {
    const { client, fake } = await harness()
    const doc = body(
      await client.callTool({
        name: 'desirecore_cdp',
        arguments: {
          targetId: 'app-main',
          method: 'DOM.getDocument',
          params: { depth: 1 },
        },
      })
    )
    expect(doc.root).toMatchObject({ nodeId: 1 })
    const query = await client.callTool({
      name: 'desirecore_cdp',
      arguments: {
        targetId: 'app-main',
        method: 'DOM.querySelector',
        params: { nodeId: 1, selector: 'body' },
      },
    })
    expect(query.isError).not.toBe(true)
    expect(body(query).nodeId).toBe(2)
    expect(fake.packets.filter((packet) => packet.method === 'Target.attachToTarget')).toHaveLength(1)
  })
  it('处理大截图而不发生正则栈溢出，并拒绝超限图片', async () => {
    const { client, fake } = await harness()
    const bytes = Buffer.alloc(2 * 1024 * 1024)
    Buffer.from(PNG, 'base64').copy(bytes)
    fake.setScreenshot(bytes.toString('base64'))
    const result = await client.callTool({ name: 'desirecore_screenshot', arguments: { targetId: 'app-main' } })
    expect(result.isError).not.toBe(true)
    fake.setScreenshot(Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'))
    expect(
      (await client.callTool({ name: 'desirecore_screenshot', arguments: { targetId: 'app-main' } })).isError
    ).toBe(true)
  })
  it('默认拒绝控制、任意 eval、路由覆盖与多余参数，且不发送副作用', async () => {
    const { client, fake } = await harness()
    for (const call of [
      { name: 'desirecore_evaluate', arguments: { targetId: 'app-main', expression: 'false' } },
      {
        name: 'desirecore_cdp',
        arguments: { targetId: 'app-main', method: 'Page.navigate', params: { url: 'https://example.com' } },
      },
      {
        name: 'desirecore_cdp',
        arguments: { targetId: 'app-main', method: 'Input.insertText', params: { text: 'hi' } },
      },
      { name: 'desirecore_screenshot', arguments: { targetId: 'app-main', sessionId: 'other' } },
      { name: 'desirecore_screenshot', arguments: {} },
    ])
      expect((await client.callTool(call)).isError).toBe(true)
    expect(fake.packets).toHaveLength(0)
  })
  it('不能以假标题选择嵌入网页；丢失窗口不自动回落主窗口', async () => {
    const { client, fake } = await harness()
    for (const targetId of ['web', 'missing'])
      expect((await client.callTool({ name: 'desirecore_screenshot', arguments: { targetId } })).isError).toBe(true)
    expect(fake.packets.some((packet) => packet.method === 'Page.captureScreenshot')).toBe(false)
  })
  it('保留 false/undefined，页面异常和协议错误返回 isError', async () => {
    const { client } = await harness(true)
    expect(
      body(
        await client.callTool({ name: 'desirecore_evaluate', arguments: { targetId: 'app-main', expression: 'false' } })
      ).result
    ).toEqual({ type: 'boolean', value: false })
    expect(
      body(
        await client.callTool({
          name: 'desirecore_evaluate',
          arguments: { targetId: 'app-main', expression: 'undefined' },
        })
      ).result
    ).toEqual({ type: 'undefined' })
    expect(
      (
        await client.callTool({
          name: 'desirecore_evaluate',
          arguments: { targetId: 'app-main', expression: 'throw-test' },
        })
      ).isError
    ).toBe(true)
    expect(
      (
        await client.callTool({
          name: 'desirecore_cdp',
          arguments: { targetId: 'app-main', method: 'DOM.getDocument', params: { depth: -99 } },
        })
      ).isError
    ).toBe(true)
    expect(body(await client.callTool({ name: 'desirecore_status' })).connected).toBe(true)
  })
  it('显式开启后可输入，但仍不允许任意 CDP domain', async () => {
    const { client, fake } = await harness(true)
    expect(
      (
        await client.callTool({
          name: 'desirecore_cdp',
          arguments: { targetId: 'app-main', method: 'Input.insertText', params: { text: 'hello' } },
        })
      ).isError
    ).not.toBe(true)
    expect(fake.packets.filter((packet) => packet.method === 'Input.insertText')).toHaveLength(1)
    for (const method of [
      'Browser.close',
      'Target.createTarget',
      'Network.getAllCookies',
      'Fetch.enable',
      'Page.navigate',
    ]) {
      expect(
        (await client.callTool({ name: 'desirecore_cdp', arguments: { targetId: 'app-main', method } })).isError
      ).toBe(true)
    }
  })
  it('超时标记结果未知，不重放也不重新连接', async () => {
    const { client, fake } = await harness(true, 500)
    const result = await client.callTool({
      name: 'desirecore_cdp',
      arguments: { targetId: 'app-main', method: 'Input.insertText', params: { text: 'stall' } },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('结果未知')
    expect((await client.callTool({ name: 'desirecore_status' })).isError).toBe(true)
    expect(fake.connections()).toBe(1)
    expect(fake.packets.filter((packet) => packet.method === 'Input.insertText')).toHaveLength(1)
  })
  it('服务端断开使在途操作失败且标明结果未知', async () => {
    const { client, fake } = await harness(true)
    const result = await client.callTool({
      name: 'desirecore_cdp',
      arguments: { targetId: 'app-main', method: 'Input.insertText', params: { text: 'disconnect' } },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('结果未知')
    expect((await client.callTool({ name: 'desirecore_status' })).isError).toBe(true)
    expect(fake.connections()).toBe(1)
  })
  it('连接关闭后不自动重新发现端口，坏 JSON 不导致进程崩溃', async () => {
    const { client, fake } = await harness()
    for (const socket of fake.sockets) socket.send('{malformed')
    await new Promise((done) => setTimeout(done, 30))
    expect((await client.callTool({ name: 'desirecore_status' })).isError).toBe(true)
    expect(fake.connections()).toBe(1)
  })
  it('取消在途 CDP 命令会释放请求且不自动重试', async () => {
    const { bridge, fake } = await harness(true)
    const controller = new AbortController()
    const pending = bridge.send('Input.insertText', { text: 'stall' }, undefined, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/结果未知/)
    await expect(bridge.send('Browser.getVersion')).rejects.toThrow()
    expect(fake.connections()).toBe(1)
  })
  it('不同客户端可复用 JSON-RPC id；同一实例的控制操作不交叉执行', async () => {
    const { client, connect, service, fake } = await harness(true, 500)
    const other = await connect()
    expect((await other.listTools()).tools).toHaveLength(6)
    expect(body(await client.callTool({ name: 'desirecore_status' })).connected).toBe(true)
    expect(body(await other.callTool({ name: 'desirecore_status' })).connected).toBe(true)
    const first = service.call('desirecore_cdp', {
      targetId: 'app-main',
      method: 'Input.insertText',
      params: { text: 'stall' },
    })
    const second = await service.call('desirecore_cdp', {
      targetId: 'app-main',
      method: 'Input.insertText',
      params: { text: 'must-not-send' },
    })
    expect(second.isError).toBe(true)
    expect(JSON.stringify(second)).toContain('本次未执行')
    await first
    expect(fake.packets.filter((packet) => packet.method === 'Input.insertText')).toHaveLength(1)
  })
  it('chunked 请求同样受大小限制，stdio 工具参数也有独立上限', async () => {
    const { http, service, fake } = await harness()
    const status = await new Promise<number>((done, reject) => {
      const req = request(
        http.url,
        { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' } },
        (res) => {
          res.resume()
          done(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.write('x'.repeat(MAX_REQUEST_BYTES))
      req.end('x')
    })
    expect(status).toBe(413)
    const result = await service.call('desirecore_cdp', {
      targetId: 'app-main',
      method: 'DOM.getDocument',
      params: { data: 'x'.repeat(MAX_REQUEST_BYTES) },
    })
    expect(result.isError).toBe(true)
    expect(fake.packets).toHaveLength(0)
  })
  it('鉴权、Origin、Host、路由、方法与请求体限制在执行前生效', async () => {
    const { http, fake } = await harness()
    expect((await fetch(http.url, { method: 'POST', body: '{}' })).status).toBe(401)
    expect(
      (
        await fetch(http.url, {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${'wrong-'.repeat(10)}` },
          body: '{}',
        })
      ).status
    ).toBe(401)
    expect(
      (await fetch(http.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' }))
        .status
    ).toBe(403)
    const badHost = await new Promise<number>((done, reject) => {
      const req = request(http.url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (res) => {
        res.resume()
        done(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end('{}')
    })
    expect(badHost).toBe(403)
    expect((await fetch(`${http.url}?token=${TOKEN}`, { method: 'POST', headers, body: '{}' })).status).toBe(404)
    expect((await fetch(http.url, { headers })).status).toBe(405)
    expect((await fetch(http.url, { method: 'DELETE', headers })).status).toBe(405)
    expect((await fetch(http.url, { method: 'POST', headers, body: '{' })).status).toBe(400)
    expect((await fetch(http.url, { method: 'POST', headers, body: 'x'.repeat(MAX_REQUEST_BYTES + 1) })).status).toBe(
      413
    )
    expect((await fetch(http.url.replace('/mcp', '/healthz'), { headers })).status).toBe(200)
    expect(fake.packets).toHaveLength(0)
  })
})

describe('真实 SDK ↔ stdio CLI ↔ 模拟 CDP', () => {
  it('Windows 兼容的 Node 显式入口可初始化、列工具、实际截图并正常关闭', async () => {
    const fake = await startFakeCdp()
    closeables.push(fake.close)
    const client = new Client({ name: 'stdio-test', version: '1.0.0' })
    closeables.push(() => client.close())
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('node_modules/tsx/dist/cli.mjs'),
        '--tsconfig',
        resolve('tsconfig.json'),
        resolve('src/cli.ts'),
        '--cdp-port',
        String(fake.port),
      ],
      // 模拟 MCP 宿主不在仓库目录启动；不依赖 npm shim、PATH 上的 tsx 或当前目录的 tsconfig。
      cwd: tmpdir(),
      stderr: 'pipe',
    })
    await client.connect(transport)
    expect((await client.listTools()).tools).toHaveLength(5)
    const list = body(await client.callTool({ name: 'desirecore_list_instances' }))
    const instanceId = (list.instances as JsonObject[])[0].instanceId
    const shot = await client.callTool({
      name: 'desirecore_screenshot',
      arguments: { instanceId, targetId: 'app-main' },
    })
    expect(shot.content).toEqual([{ type: 'image', data: PNG, mimeType: 'image/png' }])
    await client.close()
    expect(fake.packets.some((packet) => packet.method === 'Browser.close')).toBe(false)
  })
})
