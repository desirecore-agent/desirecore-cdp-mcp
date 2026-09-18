import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// 用发布包自己的依赖和编译入口，从系统临时目录启动；不读取实际实例。
const npm = process.env.npm_execpath
if (!npm) throw new Error('请通过 npm run test:package 执行')
const root = await mkdtemp(join(tmpdir(), 'desirecore-mcp-package-'))
function run(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', timeout: 120000 })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'npm command failed')
  return result.stdout
}
let client
let applicationProcess
try {
  const pack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', root]))[0]
  for (const file of pack.files) {
    assert.match(
      file.path,
      /^(dist\/|bin\/|examples\/|package.json$|application.json$|LICENSE$|NOTICE$|README(?:.zh-CN)?.md$|CHANGELOG.md$|SECURITY.md$)/
    )
    assert.doesNotMatch(file.path, /(?:^|\/)(?:node_modules|\.env|token|registry\.json)(?:\/|$)/)
  }
  const artifact = join(root, pack.filename)
  await writeFile(join(root, 'package.json'), '{"private":true}\n')
  run(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], root)
  await writeFile(join(root, 'empty-registry.json'), '{"version":1,"instances":[]}\n')
  const entry = join(root, 'node_modules/desirecore-cdp-mcp/bin/desirecore-cdp-mcp.cjs')
  const help = spawnSync(process.execPath, [entry, '--help'], { cwd: root, encoding: 'utf8', timeout: 10000 })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /desirecore-cdp-mcp/)
  assert.match(help.stdout, /--chatgpt-tunnel/)
  // 验证真正的 npm bin/shim，不仅是 Node 直接加载兼容入口。
  assert.match(run(['exec', '--offline', '--', 'desirecore-control', '--help'], root), /DesireCore Control/)
  const reserve = createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise((done) => reserve.close(done))
  const token = 'package-application-test-'.repeat(3)
  await writeFile(join(root, 'private-token'), token)
  const applicationEntry = join(root, 'node_modules/desirecore-cdp-mcp/bin/desirecore-control.cjs')
  applicationProcess = spawn(
    process.execPath,
    [
      applicationEntry,
      '--registry',
      join(root, 'empty-registry.json'),
      '--port',
      String(port),
      '--token-file',
      join(root, 'private-token'),
    ],
    {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('应用启动超时')), 10000)
    const fail = (error) => {
      clearTimeout(timeout)
      reject(error)
    }
    applicationProcess.once('error', fail)
    applicationProcess.once('exit', (code) => fail(new Error('应用提前退出 ' + code)))
    applicationProcess.stderr.on('data', (data) => {
      if (data.toString().includes('本机管理页面')) {
        clearTimeout(timeout)
        done()
      }
    })
  })
  const appUrl = `http://127.0.0.1:${port}`
  assert.equal((await fetch(appUrl)).status, 200)
  assert.match(await (await fetch(appUrl)).text(), /ChatGPT 安全隧道/)
  assert.equal(
    (await fetch(appUrl + '/api/tunnel/status', { headers: { Authorization: 'Bearer ' + token } })).status,
    401
  )
  assert.equal((await fetch(appUrl + '/api/overview')).status, 401)
  const overview = await (
    await fetch(appUrl + '/api/overview', { headers: { Authorization: 'Bearer ' + token } })
  ).json()
  assert.equal(overview.application.kind, 'app')
  assert.equal(overview.application.registerInternalMcp, false)
  assert.deepEqual(overview.instances, [])
  client = new Client({ name: 'package-smoke', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, '--registry', join(root, 'empty-registry.json')],
      cwd: root,
      stderr: 'pipe',
    })
  )
  assert.equal(client.getServerVersion().version, JSON.parse(await readFile(resolve('package.json'), 'utf8')).version)
  assert.equal((await client.listTools()).tools.length, 5)
  const result = await client.callTool({ name: 'desirecore_list_instances' })
  assert.notEqual(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0].text).instances, [])
  console.log(
    JSON.stringify({
      packaged: pack.filename,
      files: pack.files.length,
      standalone: true,
      applicationDashboard: true,
      internalMcpRegistration: false,
      zeroInstanceStartup: true,
      tools: 5,
    })
  )
} finally {
  if (applicationProcess && applicationProcess.exitCode === null && applicationProcess.signalCode === null) {
    const exited = once(applicationProcess, 'exit')
    applicationProcess.kill('SIGTERM')
    await exited
  }
  await client?.close()
  await rm(root, { recursive: true, force: true })
}
