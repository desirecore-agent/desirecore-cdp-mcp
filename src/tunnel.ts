import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv from 'ajv'
import type { JSONSchema7 } from 'json-schema'
import type { FromSchema } from 'json-schema-to-ts'
import { readBoundedText } from './local-state.js'

export const tunnelStartSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tunnelId'],
  properties: {
    tunnelId: {
      type: 'string',
      pattern: '^tunnel_[a-f0-9]{32}$',
      description: '操作者在 OpenAI Platform 创建并关联 ChatGPT 工作区的 Tunnel ID。',
    },
    apiKey: {
      type: 'string',
      minLength: 20,
      maxLength: 4096,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        '可选的 Tunnels Read + Use 运行 key；只用于本次子进程，不持久保存或回显。省略时读取启动时指定的 key 文件或 CONTROL_PLANE_API_KEY。',
    },
  },
} as const satisfies JSONSchema7
export type TunnelStart = FromSchema<typeof tunnelStartSchema>
const validateStart = new Ajv().compile<TunnelStart>(tunnelStartSchema)

export interface TunnelStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  ready: boolean | null
  tunnelId?: string
  pid?: number
  healthUrl?: string
  lastError?: string
  client: string
  configuredTunnelId?: string
  credentialConfigured: boolean
  chatgptVerified: false
}

export interface TunnelOptions {
  clientPath?: string
  tunnelId?: string
  apiKeyFile?: string
  stateDirectory: string
  env?: NodeJS.ProcessEnv
}
export interface TunnelDeps {
  spawn: (file: string, args: string[], options: SpawnOptions) => ChildProcess
}

/** 新建每进程独立的管理凭据；此凭据从不传给 tunnel-client 或 MCP 客户端。 */
export function createTunnelControl(mcpToken: string, options: TunnelOptions, deps?: TunnelDeps): TunnelControl {
  mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(options.stateDirectory, 'control-session-'))
  const token = randomBytes(32).toString('hex')
  const tokenFile = join(directory, 'admin-token')
  try {
    writeFileSync(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 })
    const manager = new TunnelSupervisor(mcpToken, { ...options, stateDirectory: directory }, deps)
    return {
      token,
      tokenFile,
      manager,
      close: async () => {
        await manager.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
export interface TunnelControl {
  token: string
  tokenFile: string
  manager: TunnelSupervisor
  close: () => Promise<void>
}

/** 只继承 OS 与显式代理/CA 环境，不能让其他应用的 profile、MCP URL、密钥或 Harpoon 通道串入。 */
export function tunnelEnvironment(source: NodeJS.ProcessEnv, apiKey: string, mcpToken: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path',
    'home',
    'userprofile',
    'localappdata',
    'appdata',
    'systemroot',
    'windir',
    'temp',
    'tmp',
    'tmpdir',
    'lang',
    'lc_all',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
    'ssl_cert_file',
    'ssl_cert_dir',
  ])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source))
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value
  const noProxy = source.NO_PROXY ?? source.no_proxy ?? ''
  delete env.no_proxy
  env.NO_PROXY = ['127.0.0.1', 'localhost', '::1', noProxy].filter(Boolean).join(',')
  env.DESIRECORE_TUNNEL_API_KEY = apiKey
  env.DESIRECORE_TUNNEL_MCP_AUTH = 'Bearer ' + mcpToken
  env.MCP_EXTRA_HEADERS = 'Authorization: env:DESIRECORE_TUNNEL_MCP_AUTH'
  env.MCP_DISCOVERY_EXTRA_HEADERS = env.MCP_EXTRA_HEADERS
  return env
}

export function validateHealthUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) < 1 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('不接受非本机健康端点')
  return url.origin
}

class TunnelOperationError extends Error {}

interface Run {
  child: ChildProcess
  done: Promise<void>
  directory: string
  healthFile: string
  stopping: boolean
  exited: boolean
  tunnelId: string
}

/** 只托管自己启动的 native tunnel-client；不接管已有 PID、不使用 shell、不自动重放工具或重启进程。 */
export class TunnelSupervisor {
  private active?: Run
  private state: TunnelStatus['state'] = 'stopped'
  private lastError?: string
  private lastTunnelId?: string
  private mcpUrl?: string
  private transition = false
  private closed = false
  private readonly env: NodeJS.ProcessEnv
  private readonly launch: TunnelDeps['spawn']

  constructor(
    private readonly mcpToken: string,
    private readonly options: TunnelOptions,
    deps: TunnelDeps = { spawn }
  ) {
    this.env = { ...(options.env ?? process.env) }
    this.launch = deps.spawn
  }

  bindMcpUrl(value: string): void {
    const url = new URL(value)
    if (
      this.mcpUrl ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.pathname !== '/mcp' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('隧道只能绑定本应用的本机 MCP 地址')
    this.mcpUrl = url.href
  }

  private credential(input: TunnelStart): string {
    let key = input.apiKey
    if (key === undefined && this.options.apiKeyFile) {
      try {
        key = readBoundedText(this.options.apiKeyFile, 8192).trim()
      } catch {
        throw new TunnelOperationError('无法读取指定的隧道 key 文件；不会回落到其他凭据')
      }
    }
    if (key === undefined) key = this.env.CONTROL_PLANE_API_KEY
    if (!key || !/^[A-Za-z0-9_-]{20,4096}$/.test(key))
      throw new TunnelOperationError(
        '需要有效的 Tunnel 运行 key：在页面输入、使用 --tunnel-key-file 或 CONTROL_PLANE_API_KEY'
      )
    return key
  }

  async start(raw: unknown): Promise<TunnelStatus> {
    if (!validateStart(raw)) throw new Error('隧道参数无效：仅接受合法 tunnelId 和可选运行 apiKey')
    if (this.closed) throw new Error('应用正在退出，不能启动隧道')
    if (this.transition || this.active) throw new Error('隧道正在运行或切换；先停止后再启动，本次未执行')
    if (!this.mcpUrl) throw new Error('本机 MCP HTTP 尚未就绪')
    this.transition = true
    let directory: string | undefined
    try {
      const apiKey = this.credential(raw)
      mkdirSync(this.options.stateDirectory, { recursive: true, mode: 0o700 })
      directory = mkdtempSync(join(this.options.stateDirectory, 'tunnel-'))
      const healthFile = join(directory, 'health-url')
      const configFile = join(directory, 'client.yaml')
      // 显式空 profile 阻断其他安装的默认配置；密钥只经子进程环境传递。
      writeFileSync(configFile, 'config_version: 1\n', { flag: 'wx', mode: 0o600 })
      const args = [
        'run',
        '--config',
        configFile,
        '--control-plane.base-url',
        'https://api.openai.com',
        '--control-plane.tunnel-id',
        raw.tunnelId,
        '--control-plane.api-key',
        'env:DESIRECORE_TUNNEL_API_KEY',
        '--control-plane.poll-channel',
        'main',
        '--mcp.server-url',
        this.mcpUrl,
        '--health.listen-addr',
        '127.0.0.1:0',
        '--health.url-file',
        healthFile,
        '--log.level',
        'warn',
        '--log.format',
        'json',
        '--log.http-raw-unsafe=false',
      ]
      this.state = 'starting'
      this.lastError = undefined
      this.lastTunnelId = raw.tunnelId
      const child = this.launch(this.options.clientPath ?? 'tunnel-client', args, {
        cwd: directory,
        env: tunnelEnvironment(this.env, apiKey, this.mcpToken),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
      let finished!: () => void
      const done = new Promise<void>((resolve) => {
        finished = resolve
      })
      const run: Run = { child, directory, healthFile, done, stopping: false, exited: false, tunnelId: raw.tunnelId }
      this.active = run
      // 不保存/转发 stdout 或 stderr；原始输出可能含第三方协议正文或凭据。
      child.stdout?.resume()
      child.stderr?.resume()
      child.once('error', () => {
        this.lastError = '无法启动官方 tunnel-client；请检查安装路径与执行权限'
        this.state = 'error'
      })
      child.once('exit', () => {
        run.exited = true
      })
      child.once('close', (code) => {
        run.exited = true
        if (this.active === run) {
          this.active = undefined
          this.state = run.stopping ? 'stopped' : 'error'
          if (!run.stopping) this.lastError ??= `tunnel-client 已退出（退出码 ${code ?? '未知'}）；不会自动重启`
        }
        try {
          rmSync(run.directory, { recursive: true, force: true })
        } catch {
          this.lastError = '隧道已退出，但临时状态未能清理；请检查本机目录权限'
        } finally {
          finished()
        }
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          run.stopping = true
          child.kill('SIGKILL')
          reject(new TunnelOperationError('隧道进程启动超时'))
        }, 5000)
        child.once('spawn', () => {
          clearTimeout(timer)
          resolve()
        })
        child.once('error', () => {
          clearTimeout(timer)
          reject(new TunnelOperationError('无法启动官方 tunnel-client；请用 --tunnel-client 指定已安装的可执行文件'))
        })
      })
      if (this.closed) {
        run.stopping = true
        child.kill('SIGTERM')
        throw new TunnelOperationError('应用已退出，已取消隧道启动')
      }
      if (this.active === run && !run.exited) this.state = 'running'
      return this.snapshot()
    } catch (error) {
      this.state = 'error'
      // 所有上游错误都保持有界，不接收子进程的原始 error.message。
      this.lastError =
        error instanceof TunnelOperationError ? error.message : '隧道启动失败；请检查客户端路径、私有目录权限与本机配置'
      if (!this.active && directory) {
        try {
          rmSync(directory, { recursive: true, force: true })
        } catch {
          /* 保留启动失败的原始安全诊断。 */
        }
      }
      throw new Error(this.lastError)
    } finally {
      this.transition = false
    }
  }

  private snapshot(): TunnelStatus {
    return {
      state: this.state,
      ready: null,
      tunnelId: this.active?.tunnelId ?? this.lastTunnelId,
      pid: this.active && !this.active.exited ? this.active.child.pid : undefined,
      lastError: this.lastError,
      client: this.options.clientPath ?? 'tunnel-client',
      configuredTunnelId: this.options.tunnelId,
      credentialConfigured: !!(this.options.apiKeyFile || this.env.CONTROL_PLANE_API_KEY),
      chatgptVerified: false,
    }
  }

  async status(): Promise<TunnelStatus> {
    const result = this.snapshot()
    const run = this.active
    if (!run || run.exited || run.stopping) return result
    try {
      const origin = validateHealthUrl(readBoundedText(run.healthFile, 2048))
      const response = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1500), redirect: 'error' })
      await response.body?.cancel()
      if (this.active !== run || run.exited || run.stopping) return this.snapshot()
      result.ready = response.status === 200
      result.healthUrl = origin
    } catch {
      /* 尚未监听、不可达或 URL 无效只表示未观测到就绪，不伪造成功。 */
    }
    return result
  }

  async stop(): Promise<TunnelStatus> {
    if (this.transition) throw new Error('隧道正在切换，本次停止未执行')
    this.transition = true
    try {
      const run = this.active
      if (!run) {
        this.state = 'stopped'
        this.lastError = undefined
        return this.snapshot()
      }
      this.state = 'stopping'
      run.stopping = true
      run.child.kill('SIGTERM')
      const wait = async (ms: number): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            run.done.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), ms)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      if (!(await wait(2000))) {
        run.child.kill('SIGKILL')
        if (!(await wait(2000))) throw new Error('无法确认隧道进程已停止，请检查本机进程')
      }
      return this.snapshot()
    } finally {
      this.transition = false
    }
  }

  killImmediately(): void {
    if (this.active) {
      this.active.stopping = true
      this.active.child.kill('SIGKILL')
    }
  }

  async close(): Promise<void> {
    this.closed = true
    // close 可与 start 重叠；先使子进程不能存活，再等启动事务释放。
    if (this.transition) {
      this.killImmediately()
      for (let i = 0; i < 100 && this.transition; i++) await new Promise((resolve) => setTimeout(resolve, 60))
    }
    await this.stop()
  }
}
