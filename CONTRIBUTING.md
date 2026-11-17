# 参与开发

需要 Node.js 24；Windows 桌面为主要目标平台，核心测试也在 Linux CI 执行。首次运行 `npm ci`，开发启动 `npm start`。

提交前运行：

```powershell
npm run format
npm run typecheck
npm test
npm run test:parity
npm run test:smoke
```

修改调度、持久化或资源生命周期时增加对应行为测试，并运行 `npm run test:soak`。修改沙箱时在启用 Linux 容器的真实 Docker 上运行 `npm run sandbox:build` 和 `node scripts/test-sandbox.mjs`。发布前构建 `npm run dist:win`，验证 `node scripts/smoke.mjs --packaged`。

新工具必须使用严格参数 schema，不能由模型传入身份或授权字段。副作用由主进程 broker 执行，并支持取消与重新核权。外部来源的 prompt、技能或记忆不得修改实际权限。不要在 renderer 引入 Node 或直接联网能力。

复用开源组件前先验证上游原件，记录固定 commit、许可证、原始路径、测试方式与结果，再移植。禁止把私有人设、真实 QQ 号、测试密钥或聊天记录写入测试夹具。贡献按 GPL-3.0-only 提供，保留必要来源和许可说明。

构建依赖中受影响的 minimatch 7–10 固定为 11.0.9，以避开 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)，旧版 glob 所需的 minimatch 3 不覆盖。升级构建工具时重新检查覆盖项和实际打包结果，不直接执行会降级主构建工具的 `npm audit fix --force`。
