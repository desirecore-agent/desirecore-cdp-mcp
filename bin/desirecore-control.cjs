#!/usr/bin/env node
// 应用入口固定为 HTTP；兼容的 desirecore-cdp-mcp 命令仍供外部 stdio 宿主使用。
const args = process.argv.slice(2)
const inspection = args[0] === 'list' || args[0] === 'init-token' || args.includes('--help') || args.includes('-h')
import('../dist/cli.js')
  .then(({ main }) => main(inspection ? args : ['--transport', 'http', ...args]))
  .catch((error) => {
    console.error(`[desirecore-control] ${error instanceof Error ? error.message : '启动失败'}`)
    process.exitCode = 1
  })
