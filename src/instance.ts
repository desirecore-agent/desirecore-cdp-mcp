import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { BridgeConfig } from './config.js'
import { discoverBrowserEndpoint, isObject } from './cdp.js'
import { expandHome, readBoundedText, readProcessIdentities, sameLinuxScope } from './local-state.js'

export const MAX_INSTANCES = 64

export interface InstanceBinding {
  port: number
  endpoint?: string
  assertCurrent: (signal?: AbortSignal) => void | Promise<void>
}

export interface InstanceInfo {
  instanceId?: string
  home?: string
  label: string
  pid?: number
  cdpPort: number | null
  available: boolean
  reason?: string
}

export interface DiscoveredInstance {
  info: InstanceInfo
  binding?: InstanceBinding
}

export interface Inventory {
  instances: DiscoveredInstance[]
  warnings: string[]
}

export interface DiscoveryDeps {
  identities: typeof readProcessIdentities
  endpoint: typeof discoverBrowserEndpoint
}
const defaults: DiscoveryDeps = { identities: readProcessIdentities, endpoint: discoverBrowserEndpoint }

interface LockIdentity {
  pid: number
  startedAt: string
  token: string
  signature: string
}

function readLock(home: string): LockIdentity {
  const value: unknown = JSON.parse(readBoundedText(join(home, 'agent-service.lock', 'meta.json')))
  if (!isObject(value)) throw new Error('实例锁格式无效')
  const signature = value.processStartIdentity ?? value.processStartSignature
  if (
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > 2147483647 ||
    typeof value.startedAt !== 'string' ||
    !value.startedAt ||
    typeof value.token !== 'string' ||
    !value.token ||
    typeof signature !== 'string' ||
    !signature
  )
    throw new Error('实例锁缺少可靠的进程启动身份')
  if (value.hostname !== hostname()) throw new Error('实例锁不属于当前主机，无法证明存活')
  if (!sameLinuxScope(value.processBootId, value.processPidNamespace)) throw new Error('实例锁不属于当前进程作用域')
  return { pid: value.pid, startedAt: value.startedAt, token: value.token, signature }
}

function readPort(home: string): number {
  const raw = readBoundedText(join(home, 'cdp.port'), 32).trim()
  const port = Number(raw)
  if (!/^[1-9]\d{0,4}$/.test(raw) || port > 65535) throw new Error('未开放 CDP 或 cdp.port 无效')
  return port
}

function id(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '实例未运行或未开放 CDP'
  return error instanceof Error ? error.message.slice(0, 256) : '实例不可用'
}

/** 名录只是候选来源；只读、带上限，并按真实路径去重，不扫描端口或整个磁盘。 */
function candidateHomes(config: BridgeConfig, warnings: string[]): string[] {
  if (config.home) return [config.home]
  const homes: string[] = []
  const path = config.registryPath ?? join(homedir(), '.desirecore-instances', 'registry.json')
  try {
    const parsed: unknown = JSON.parse(readBoundedText(path, 1024 * 1024))
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.instances))
      throw new Error('不支持的实例名录格式')
    for (const entry of parsed.instances) {
      if (isObject(entry) && typeof entry.home === 'string' && isAbsolute(entry.home)) homes.push(entry.home)
      else warnings.push('已忽略无效的实例名录条目')
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) warnings.push(errorMessage(error))
  }
  if (!config.registryPath) {
    for (const home of [
      join(homedir(), '.desirecore'),
      join(homedir(), '.desirecore-dev'),
      process.env.DESIRECORE_HOME,
    ]) {
      if (home && existsSync(expandHome(home))) homes.push(expandHome(home))
    }
  }
  const unique = new Map<string, string>()
  for (const home of homes) {
    // 不因名录内容主动访问 Windows UNC 网络路径。
    if (/^(\\\\|\/\/)/.test(home)) {
      warnings.push('已忽略网络 home 路径')
      continue
    }
    let canonical = home
    try {
      canonical = realpathSync.native(home)
    } catch {
      /* 保留不存在的条目以说明原因。 */
    }
    unique.set(process.platform === 'win32' ? canonical.toLowerCase() : canonical, canonical)
  }
  if (unique.size > MAX_INSTANCES)
    warnings.push(`名录有 ${unique.size} 个目录，本次仅检查前 ${MAX_INSTANCES} 个；可用 --home 缩小范围`)
  return [...unique.values()].slice(0, MAX_INSTANCES)
}

/** 每次请求刷新：先证明 PID 启动身份，再读真实端口并探测 loopback CDP。 */
export async function discoverInstances(
  config: BridgeConfig,
  signal: AbortSignal,
  deps = defaults
): Promise<Inventory> {
  signal.throwIfAborted()
  if (config.cdpPort !== undefined) {
    try {
      const port = config.cdpPort
      const endpoint = await deps.endpoint(port, signal)
      return {
        warnings: [],
        instances: [
          {
            info: { instanceId: id(['port', port, endpoint]), label: `CDP ${port}`, cdpPort: port, available: true },
            binding: { port, endpoint, assertCurrent: () => undefined },
          },
        ],
      }
    } catch (error) {
      return {
        warnings: [],
        instances: [
          {
            info: {
              label: `CDP ${config.cdpPort}`,
              cdpPort: config.cdpPort,
              available: false,
              reason: errorMessage(error),
            },
          },
        ],
      }
    }
  }
  const warnings: string[] = []
  const candidates = candidateHomes(config, warnings).map((home) => {
    const info: InstanceInfo = { home, label: basename(home), cdpPort: null, available: false }
    try {
      return { info, lock: readLock(home) }
    } catch (error) {
      info.reason = errorMessage(error)
      return { info, lock: undefined }
    }
  })
  const identities = await deps.identities(
    candidates.flatMap(({ lock }) => (lock ? [lock.pid] : [])),
    signal
  )
  const instances: DiscoveredInstance[] = new Array(candidates.length)
  let cursor = 0
  // 有界并发探测，单个坏实例不阻塞其余实例；不并发执行用户命令。
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const index = cursor++
        const { info, lock } = candidates[index]
        const home = info.home!
        instances[index] = { info }
        if (!lock) continue
        info.pid = lock.pid
        if (identities.get(lock.pid) !== lock.signature) {
          info.reason = '进程已退出、PID 被复用或身份无法验证；不读取残留端口'
          continue
        }
        try {
          const port = readPort(home)
          info.cdpPort = port
          const endpoint = await deps.endpoint(port, AbortSignal.any([signal, AbortSignal.timeout(1500)]))
          const signature = JSON.stringify(lock)
          const assertCurrent = async (checkSignal = AbortSignal.timeout(config.timeoutMs)): Promise<void> => {
            checkSignal.throwIfAborted()
            if (JSON.stringify(readLock(home)) !== signature || readPort(home) !== port) {
              throw new Error('实例身份或 CDP 端口已变化；请重新列举并选择新 instanceId，旧调用不会重放')
            }
            const actual = await deps.identities([lock.pid], checkSignal)
            if (actual.get(lock.pid) !== lock.signature) throw new Error('实例进程身份已失效；拒绝操作')
            if (JSON.stringify(readLock(home)) !== signature || readPort(home) !== port)
              throw new Error('实例在验证期间发生变化')
          }
          // 探测期间退出/重启的实例不得进入可操作清单。
          if (JSON.stringify(readLock(home)) !== signature || readPort(home) !== port)
            throw new Error('实例在发现期间发生变化')
          info.instanceId = id([process.platform === 'win32' ? home.toLowerCase() : home, lock, port, endpoint])
          info.available = true
          instances[index].binding = { port, endpoint, assertCurrent }
        } catch (error) {
          info.reason = errorMessage(error)
        }
      }
    })
  )
  signal.throwIfAborted()
  return { instances, warnings: [...new Set(warnings)] }
}
