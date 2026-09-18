# Contributing / 贡献

Use Node.js >=22.22.2, then `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:package`. The suite uses simulated CDP and temporary data; never substitute a real user's home in automated tests.

Open a feature branch and pull request. Keep protocol/configuration schemas, tests, README.md and README.zh-CN.md aligned. Preserve instance-generation routing, readonly defaults, bounded I/O and no-replay behavior. New side effects require explicit local opt-in.

发布时更新 package.json/version、CHANGELOG 和市场候选元数据，审查依赖锁及 npm pack 清单。推送 vX.Y.Z 标签后由 Release 工作流构建并上传 npm tarball 与 SHA256SUMS；附件不得覆盖。Registry 只保存已发布制品的固定版本和 SHA-256，不复制源代码或使用 latest。不要在 PR 中附带真实 token/用户截图。
