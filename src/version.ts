// 版本由 package.json 构建期导入；发行验证会核对 MCP 握手版本。
import { readFileSync } from 'node:fs'
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
