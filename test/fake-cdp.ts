import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { isObject, type JsonObject } from '../src/cdp.js'

// 固定 1×1 PNG，仅为协议测试数据，不读取真实桌面。
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII='

export interface FakeCdp {
  port: number
  packets: JsonObject[]
  origins: Array<string | undefined>
  sockets: Set<WebSocket>
  connections: () => number
  setScreenshot: (data: string) => void
  close: () => Promise<void>
}

/** 最小 browser + flattened session CDP，覆盖两应用窗口及一个不可信网页。 */
export async function startFakeCdp(): Promise<FakeCdp> {
  let port = 0
  let connections = 0
  let screenshot = PNG
  const packets: JsonObject[] = []
  const origins: Array<string | undefined> = []
  const http = createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.writeHead(404).end()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-browser` }))
  })
  const wss = new WebSocketServer({ server: http, path: '/devtools/browser/fake-browser' })
  wss.on('connection', (socket, request) => {
    connections++
    origins.push(request.headers.origin)
    const sessions = new Map<string, string>()
    const documents = new Set<string>()
    socket.on('message', (raw) => {
      const packet: unknown = JSON.parse(raw.toString())
      if (!isObject(packet)) return
      packets.push(packet)
      const params = isObject(packet.params) ? packet.params : {}
      const target = typeof packet.sessionId === 'string' ? sessions.get(packet.sessionId) : undefined
      const send = (result: JsonObject): void => {
        socket.send(JSON.stringify({ id: packet.id, result, sessionId: packet.sessionId }))
      }
      const error = (message: string): void => {
        socket.send(JSON.stringify({ id: packet.id, error: { code: -32000, message }, sessionId: packet.sessionId }))
      }
      switch (packet.method) {
        case 'Browser.getVersion':
          send({ product: 'FakeElectron/1', protocolVersion: '1.3' })
          return
        case 'Target.getTargets':
          send({
            targetInfos: [
              { targetId: 'app-main', type: 'page', title: 'DesireCore', url: 'http://localhost:5173/' },
              {
                targetId: 'app-chat',
                type: 'page',
                title: 'Conversation',
                url: 'http://localhost:5173/?window=conversation',
              },
              { targetId: 'web', type: 'page', title: 'DesireCore', url: 'https://untrusted.example/' },
            ],
          })
          return
        case 'Target.attachToTarget': {
          const session = `session-${String(params.targetId)}`
          sessions.set(session, String(params.targetId))
          send({ sessionId: session })
          return
        }
        case 'Target.detachFromTarget':
          sessions.delete(String(params.sessionId))
          documents.delete(String(params.sessionId))
          send({})
          return
        case 'Runtime.evaluate': {
          if (params.expression === 'typeof window.conveyor') {
            send({ result: { type: 'string', value: target?.startsWith('app-') ? 'object' : 'undefined' } })
            return
          }
          if (params.expression === 'throw-test') {
            send({ exceptionDetails: { text: 'Uncaught', exception: { description: 'test-error' } } })
            return
          }
          if (params.expression === 'false') {
            send({ result: { type: 'boolean', value: false } })
            return
          }
          if (params.expression === 'undefined') {
            send({ result: { type: 'undefined' } })
            return
          }
          send({ result: { type: 'number', value: 2 } })
          return
        }
        case 'Page.captureScreenshot':
          send({ data: screenshot })
          return
        case 'Input.insertText': {
          if (params.text === 'stall') return
          if (params.text === 'disconnect') {
            socket.close()
            return
          }
          send({})
          return
        }
        case 'DOM.querySelector': {
          if (!documents.has(String(packet.sessionId)) || params.nodeId !== 1) {
            error('No node with given id found')
            return
          }
          send({ nodeId: 2 })
          return
        }
        case 'DOM.getDocument': {
          if (params.depth === -99) {
            error('test protocol failure')
            return
          }
          documents.add(String(packet.sessionId))
          send({ root: { nodeId: 1, nodeName: '#document', target } })
          return
        }
        default:
          error('Method not found')
      }
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('fake CDP 没有端口')
  port = address.port
  return {
    port,
    packets,
    origins,
    sockets: wss.clients,
    connections: () => connections,
    setScreenshot: (data) => {
      screenshot = data
    },
    close: async () => {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      const closed = new Promise<void>((resolve) => http.close(() => resolve()))
      http.closeAllConnections()
      await closed
    },
  }
}
