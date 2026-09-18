// 仅测试使用：模拟官方 native 客户端的 argv/env、动态 health URL 和生命周期，不连接 OpenAI。
const http = require('node:http')
const fs = require('node:fs')
const args = process.argv.slice(2)
const arg = (name) => args[args.indexOf(name) + 1]
const url = arg('--mcp.server-url')
const id = arg('--control-plane.tunnel-id')
const key = process.env.DESIRECORE_TUNNEL_API_KEY
const auth = process.env.DESIRECORE_TUNNEL_MCP_AUTH
// 故意写出模拟秘密，监督器必须丢弃输出，不能进入状态或页面。
process.stdout.write('fixture-secret:' + key + '\n')
process.stderr.write('fixture-authorization:' + auth + '\n')
let ready = false
let protocolOkay = false
let names = []
const server = http.createServer((req, res) => {
  if (req.url === '/crash') {
    res.end()
    setTimeout(() => process.exit(7), 10)
    return
  }
  if (req.url === '/readyz') {
    res.writeHead(ready ? 200 : 503).end()
    return
  }
  if (req.url === '/evidence') {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        id,
        mcpUrl: url,
        protocolOkay,
        names,
        keys: Object.keys(process.env),
        args,
        keyInArgv: args.some((a) => a.includes(key)),
        discoveryMatches: process.env.MCP_DISCOVERY_EXTRA_HEADERS === process.env.MCP_EXTRA_HEADERS,
        config: fs.readFileSync(arg('--config'), 'utf8'),
      })
    )
    return
  }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1', async () => {
  fs.writeFileSync(arg('--health.url-file'), `http://127.0.0.1:${server.address().port}`, { mode: 0o600 })
  try {
    const headers = {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    const initialized = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'tunnel-fixture', version: '1.0.0' },
        },
      }),
    })
    protocolOkay = initialized.status === 200
    await initialized.body?.cancel()
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    const body = await response.json()
    names = body.result?.tools?.map((t) => t.name) ?? []
    ready = protocolOkay && names.includes('desirecore_list_instances') && !args.includes('--fixture-never-ready')
  } catch {
    /* 测试断开时保持未就绪。 */
  }
})
process.once('SIGTERM', () => server.close(() => process.exit(0)))
