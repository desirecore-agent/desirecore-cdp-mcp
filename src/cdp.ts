import WebSocket, { type RawData } from 'ws'
import type { InstanceBinding } from './instance.js'

export type JsonObject = Record<string, unknown>
export const MAX_CDP_BYTES = 8 * 1024 * 1024

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface WindowInfo {
  targetId: string
  title: string
  url: string
}

interface Pending {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/** 只接受同一 loopback 端口的 browser endpoint，不信任发现响应中的任意 WebSocket URL。 */
export function browserEndpoint(raw: unknown, port: number): string {
  if (typeof raw !== 'string') throw new Error('CDP 没有提供 browser WebSocket endpoint')
  const url = new URL(raw)
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    Number(url.port) !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)
  )
    throw new Error('拒绝不属于指定本机 CDP 端口的 WebSocket endpoint')
  url.hostname = '127.0.0.1'
  return url.href
}

async function readDiscovery(port: number, signal: AbortSignal): Promise<JsonObject> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`CDP 发现失败：HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 64 * 1024) throw new Error('CDP 发现响应超过 64 KiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isObject(body)) throw new Error('CDP 发现响应不是 JSON 对象')
  return body
}

export async function discoverBrowserEndpoint(port: number, signal: AbortSignal): Promise<string> {
  const discovery = await readDiscovery(port, signal)
  return browserEndpoint(discovery.webSocketDebuggerUrl, port)
}

/**
 * 整个 MCP 生命周期固定一条 browser 连接；通过 flatten session 操作窗口。
 * 不重新查询端口、不自动重连、不重发命令，避免超时后重复副作用或误控另一个实例。
 */
export class CdpBridge {
  private socket?: WebSocket
  private failure?: Error
  private nextId = 0
  private pending = new Map<number, Pending>()
  // DOM nodeId 属于 CDP session；连续 getDocument/querySelector/focus 必须复用会话。
  private sessions = new Map<string, string>()

  constructor(
    private readonly binding: InstanceBinding,
    private readonly timeoutMs: number
  ) {}

  get failureMessage(): string | undefined {
    return this.failure?.message
  }

  async connect(signal = AbortSignal.timeout(this.timeoutMs)): Promise<void> {
    if (this.failure) throw this.failure
    if (this.socket) throw new Error('CDP 已经初始化，不能再次连接')
    await this.binding.assertCurrent(signal)
    const endpoint = await discoverBrowserEndpoint(this.binding.port, signal)
    if (this.binding.endpoint && endpoint !== this.binding.endpoint)
      throw new Error('CDP browser 代际已变化，请重新列举实例')
    signal.throwIfAborted()
    const socket = new WebSocket(endpoint, {
      handshakeTimeout: this.timeoutMs,
      maxPayload: MAX_CDP_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    })
    this.socket = socket
    socket.on('message', (data: RawData) => this.receive(data))
    socket.on('error', () =>
      this.fail(new Error('CDP WebSocket 出错，在途操作结果未知；不要自动重试，请核实实例后重启 MCP'))
    )
    socket.on('close', () =>
      this.fail(new Error('CDP WebSocket 已断开，在途操作结果未知；不要自动重试，请核实实例后重启 MCP'))
    )
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('CDP 握手超时')
        this.fail(error)
        finish(error)
      }, this.timeoutMs)
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal.removeEventListener('abort', onAbort)
        error ? reject(error) : resolve()
      }
      const onOpen = (): void => finish()
      const onError = (): void => finish(new Error('CDP 握手失败'))
      const onClose = (): void => finish(new Error('CDP 在握手完成前断开'))
      const onAbort = (): void => {
        const error = new Error('CDP 建连已取消，未发送工具命令')
        this.fail(error)
        finish(error)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
    try {
      await this.binding.assertCurrent(signal)
    } catch (error) {
      this.close()
      throw error
    }
  }

  private receive(raw: RawData): void {
    let message: unknown
    try {
      message = JSON.parse(raw.toString())
    } catch {
      this.fail(new Error('CDP 返回无效 JSON，在途操作结果未知；不要自动重试'))
      return
    }
    if (!isObject(message)) {
      this.fail(new Error('CDP 返回无效消息'))
      return
    }
    if (message.method === 'Target.detachedFromTarget' && isObject(message.params)) {
      for (const [target, session] of this.sessions) {
        if (session === message.params.sessionId) this.sessions.delete(target)
      }
    }
    if (typeof message.id !== 'number') return // 非响应事件没有请求 ID。
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    entry.cleanup()
    if (isObject(message.error)) {
      entry.reject(new Error(`CDP ${String(message.error.code)}: ${String(message.error.message).slice(0, 2000)}`))
    } else if (isObject(message.result)) entry.resolve(message.result)
    else entry.reject(new Error('CDP 响应缺少 result 对象'))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(error)
    }
    this.pending.clear()
    this.sessions.clear()
    this.socket?.terminate()
  }

  close(): void {
    this.fail(new Error('MCP 的 CDP 连接已关闭'))
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    if (this.failure) throw this.failure
    try {
      await this.binding.assertCurrent(signal)
    } catch (error) {
      this.close()
      throw error
    }
  }

  send(method: string, params: JsonObject = {}, sessionId?: string, signal?: AbortSignal): Promise<JsonObject> {
    if (this.failure) return Promise.reject(this.failure)
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 尚未连接'))
    if (signal?.aborted) return Promise.reject(new Error('调用已取消，未发送 CDP 请求'))
    if (this.pending.size >= 32) return Promise.reject(new Error('CDP 在途请求已达上限'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      // 超时/中断只说明结果未知，不能宣称已回滚，更不能在另一连接重放。
      const uncertain = (): void =>
        this.fail(new Error('CDP 调用超时或中断，执行结果未知；不要自动重试，请检查界面后重启 MCP'))
      const timer = setTimeout(uncertain, this.timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', uncertain)
      }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', uncertain, { once: true })
      const packet = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
      socket.send(packet, (error) => {
        if (error) this.fail(new Error('CDP 发送失败，执行结果未知；不自动重试'))
      })
    })
  }

  private async pageTargets(signal: AbortSignal): Promise<WindowInfo[]> {
    const response = await this.send('Target.getTargets', {}, undefined, signal)
    if (!Array.isArray(response.targetInfos)) throw new Error('CDP targetInfos 格式错误')
    const pages: WindowInfo[] = []
    for (const target of response.targetInfos) {
      if (!isObject(target) || target.type !== 'page') continue
      if (typeof target.targetId !== 'string' || typeof target.url !== 'string' || typeof target.title !== 'string') {
        throw new Error('CDP 窗口元数据格式错误')
      }
      if (!target.url.startsWith('devtools://'))
        pages.push({ targetId: target.targetId, title: target.title.slice(0, 512), url: target.url.slice(0, 4096) })
    }
    if (pages.length > 32) throw new Error('窗口数量超过 32，拒绝无界探测')
    const live = new Set(pages.map((page) => page.targetId))
    for (const [target, sessionId] of this.sessions) {
      if (!live.has(target)) {
        this.sessions.delete(target)
        await this.send('Target.detachFromTarget', { sessionId }, undefined, signal).catch(() => undefined)
      }
    }
    return pages
  }

  private async attached<TResult>(
    targetId: string,
    signal: AbortSignal,
    fn: (session: string) => Promise<TResult>
  ): Promise<TResult> {
    let sessionId = this.sessions.get(targetId)
    if (!sessionId) {
      if (this.sessions.size >= 32) throw new Error('窗口会话超过 32，拒绝无界创建')
      const attached = await this.send('Target.attachToTarget', { targetId, flatten: true }, undefined, signal)
      if (typeof attached.sessionId !== 'string') throw new Error('CDP attach 未返回 sessionId')
      sessionId = attached.sessionId
      this.sessions.set(targetId, sessionId)
    }
    // 断开 browser WebSocket 自动释放其会话；不关闭目标窗口。
    return fn(sessionId)
  }

  private async isApp(session: string, signal: AbortSignal): Promise<boolean> {
    const probe = await this.send(
      'Runtime.evaluate',
      { expression: 'typeof window.conveyor', returnByValue: true },
      session,
      signal
    )
    if (probe.exceptionDetails) throw new Error('应用窗口身份探测抛出异常')
    return isObject(probe.result) && probe.result.value === 'object'
  }

  async listWindows(signal: AbortSignal): Promise<WindowInfo[]> {
    await this.assertCurrent(signal)
    const windows: WindowInfo[] = []
    for (const target of await this.pageTargets(signal)) {
      if (await this.attached(target.targetId, signal, (session) => this.isApp(session, signal))) windows.push(target)
    }
    return windows
  }

  async withWindow<TResult>(
    targetId: string,
    signal: AbortSignal,
    fn: (session: string) => Promise<TResult>
  ): Promise<TResult> {
    await this.assertCurrent(signal)
    if (!(await this.pageTargets(signal)).some((target) => target.targetId === targetId))
      throw new Error('指定窗口不存在；请重新列出窗口，不会自动选择其他窗口')
    return this.attached(targetId, signal, async (session) => {
      if (!(await this.isApp(session, signal)))
        throw new Error('拒绝非 DesireCore 应用窗口（没有 Conveyor）；不会操作嵌入网页或 DevTools')
      await this.assertCurrent(signal)
      return fn(session)
    })
  }
}
