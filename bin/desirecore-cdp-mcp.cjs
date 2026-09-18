#!/usr/bin/env node
// 显式 Node 入口兼容 Windows npm shim；运行发行包不需要 tsx 或 DesireCore 源码。
import('../dist/cli.js')
  .then(({ main }) => main(process.argv.slice(2)))
  .catch((error) => {
    console.error(`[desirecore-cdp] ${error instanceof Error ? error.message : '启动失败'}`)
    process.exitCode = 1
  })
