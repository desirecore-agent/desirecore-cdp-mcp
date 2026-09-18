import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import Ajv from 'ajv'
import type { JSONSchema7 } from 'json-schema'
import type { FromSchema } from 'json-schema-to-ts'
import { expandHome } from './local-state.js'

/** 本机启动配置是权限边界；MCP 请求不能修改这些字段。 */
export const configSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['transport', 'port', 'timeoutMs', 'allowControl', 'allowedOrigins'],
  not: { required: ['home', 'cdpPort'] },
  properties: {
    registryPath: {
      type: 'string',
      minLength: 1,
      description:
        '可选自定义实例名录路径；不指定时读取当前用户的 .desirecore-instances/registry.json 及默认实例目录。',
    },
    home: {
      type: 'string',
      minLength: 1,
      description: '显式指定实例运行目录，读取其 cdp.port 并核实实例锁。与 cdpPort 互斥。',
    },
    cdpPort: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description: '操作者明确选择的本机 CDP 端口；不扫描、不猜测其他端口。',
    },
    transport: {
      type: 'string',
      enum: ['stdio', 'http'],
      default: 'stdio',
      description: '本地进程 stdio 或供本地隧道转发的 Streamable HTTP。',
    },
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      default: 9333,
      description: 'MCP HTTP 端口，仅绑定 127.0.0.1；不是 CDP 端口。',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 100,
      maximum: 60000,
      default: 15000,
      description: '一次工具调用的总截止时间（毫秒），涵盖发现、探测与 CDP 请求。',
    },
    allowControl: {
      type: 'boolean',
      default: false,
      description: '显式允许输入、重载与任意主世界 JavaScript；等同授予开发调试权限，不是沙箱。',
    },
    tokenFile: {
      type: 'string',
      minLength: 1,
      description: '存放 HTTP Bearer token 的本机文件；优先于 DESIRECORE_MCP_TOKEN，不得提交。',
    },
    allowedOrigins: {
      type: 'array',
      uniqueItems: true,
      maxItems: 16,
      default: [],
      items: { type: 'string', minLength: 1 },
      description: '额外允许的精确 HTTP Origin；默认仅接受本机同源管理页面或无 Origin 的原生客户端，私密接口仍需认证。',
    },
  },
} as const satisfies JSONSchema7

export type BridgeConfig = FromSchema<typeof configSchema>

const ajv = new Ajv({ allErrors: true, useDefaults: true, strictRequired: false })
const validate = ajv.compile<BridgeConfig>(configSchema)

export function validateConfig(value: unknown): BridgeConfig {
  if (!validate(value)) throw new Error(`MCP 配置无效：${ajv.errorsText(validate.errors)}`)
  for (const origin of value.allowedOrigins) {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('allowedOrigins 必须是无路径、凭据、query 或 fragment 的精确 HTTP(S) origin')
    }
  }
  return value
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const origins: string[] = []
  const values: Record<string, unknown> = { allowedOrigins: origins }
  const seen = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag !== '--allow-origin' && seen.has(flag)) throw new Error(`重复参数：${flag}`)
    seen.add(flag)
    if (flag === '--allow-control') {
      values.allowControl = true
      continue
    }
    const next = argv[++index]
    if (!next || next.startsWith('--')) throw new Error(`${flag} 缺少参数值`)
    switch (flag) {
      case '--home':
        values.home = expandHome(next)
        break
      case '--registry':
        values.registryPath = expandHome(next)
        break
      case '--cdp-port':
        values.cdpPort = Number(next)
        break
      case '--transport':
        values.transport = next
        break
      case '--port':
        values.port = Number(next)
        break
      case '--timeout':
        values.timeoutMs = Number(next)
        break
      case '--token-file':
        values.tokenFile = expandHome(next)
        break
      case '--allow-origin':
        origins.push(next)
        break
      default:
        throw new Error(`未知参数：${flag}`)
    }
  }
  // 自动模式不因继承某个实例的 DESIRECORE_HOME 而缩成单实例。
  if (values.registryPath === undefined && env.DESIRECORE_INSTANCES_REGISTRY_PATH) {
    values.registryPath = expandHome(env.DESIRECORE_INSTANCES_REGISTRY_PATH)
  }
  return validateConfig(values)
}

export function requireToken(config: BridgeConfig, env: NodeJS.ProcessEnv = process.env): string {
  const token = config.tokenFile ? readFileSync(config.tokenFile, 'utf8').trim() : env.DESIRECORE_MCP_TOKEN
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('HTTP 需要 32–256 位字母/数字/_/- 的独立 token：使用 --token-file 或 DESIRECORE_MCP_TOKEN')
  }
  return token
}

/** 默认凭据属于 MCP 服务自身，不依附任何 DesireCore home。 */
export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === 'win32'
    ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'DesireCoreMcp', 'token')
    : join(homedir(), '.desirecore-mcp', 'token')
}

export function prepareHttpToken(config: BridgeConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.tokenFile !== undefined || env.DESIRECORE_MCP_TOKEN !== undefined) return requireToken(config, env)
  const tokenFile = defaultTokenFile(env)
  try {
    createTokenFile(tokenFile)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  return requireToken({ ...config, tokenFile }, env)
}

export function createTokenFile(path: string): void {
  const absolute = expandHome(path)
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  // wx 保证不会覆盖已有凭据；Windows 文件权限仍取决于父目录 ACL。
  writeFileSync(absolute, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
}
