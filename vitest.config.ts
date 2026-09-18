import { defineConfig } from 'vitest/config'

// 仅运行本仓库测试；不启动 Electron、不读取真实用户实例或凭据。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 10000,
    restoreMocks: true,
  },
})
