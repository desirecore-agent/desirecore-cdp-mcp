import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import type { JSONSchema7 } from 'json-schema'
import type { FromSchema } from 'json-schema-to-ts'

/** 产品类别与通信协议独立：这是面向外部智能体的应用，不是内部服务安装清单。 */
export const applicationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'kind',
    'runtime',
    'audience',
    'controlProtocol',
    'autoStart',
    'registerInternalMcp',
    'managementPath',
    'mcpPath',
  ],
  properties: {
    id: { const: 'desirecore-control', description: '独立应用身份。' },
    name: { const: 'DesireCore Control', description: '面向人类的应用名称。' },
    kind: { const: 'app', description: '产品类型为应用，而不是内部 MCP 服务。' },
    runtime: { const: 'native-node', description: '在宿主机上运行，访问同机的 loopback CDP。' },
    audience: { const: 'external-agents', description: '消费者为 ChatGPT、Codex 等外部智能体。' },
    controlProtocol: { const: 'mcp', description: '对外控制协议，不决定市场分类。' },
    autoStart: { const: false, description: '不随 DesireCore 启停，也不安装自启动项。' },
    registerInternalMcp: { const: false, description: '不向 DesireCore 内部注册 MCP 服务。' },
    managementPath: { const: '/', description: '本机人类管理界面。' },
    mcpPath: { const: '/mcp', description: '外部智能体使用的认证接口。' },
  },
} as const satisfies JSONSchema7
export type Application = FromSchema<typeof applicationSchema>
const validate = new Ajv().compile<Application>(applicationSchema)
const raw: unknown = JSON.parse(readFileSync(new URL('../application.json', import.meta.url), 'utf8'))
if (!validate(raw)) throw new Error('application.json 不符合独立应用契约')
export const APPLICATION = raw
