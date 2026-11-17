# 验证、成本与已知限制

## 可复现检查

| 命令                                | 范围                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm test`                          | 调度、取消、范围隔离、删除依赖、权限、路径、SSRF 分类、技能快照、配置、导入、实际本机 HTTP/WS 协议、模拟 Docker API |
| `npm run test:parity`               | 原始 MaiBot Python 与移植版的 3,000 组随机流、120,000 个观察点一致性；需要 Python 3.12                              |
| `npm run test:smoke`                | 真正启动 Electron、utility process、IPC 和 SQLite；脚本模型的两轮聊天、显式记忆、六页面截图、renderer 无 Node       |
| `npm run test:soak`                 | 10,000 条消息、2,500 次脚本模型调用、加速八小时逻辑时间，检查回收后的 actor、队列、前台任务、timer 与运行句柄       |
| `npm run dist:win`                  | 构建 NSIS 与 ZIP，扫描本项目编译内容的私人数据特征                                                                  |
| `node scripts/smoke.mjs --packaged` | 真正启动 `release/win-unpacked/ChatDS.exe`，检查 asar 与发布依赖可运行                                              |
| `node scripts/test-sandbox.mjs`     | 需真实 Linux Docker 与镜像；验证 uid、只读根文件系统、断网、临时副本与取消后容器删除                                |

测试模式强制使用系统临时目录的 `chatds-test-*` 独立数据，脚本模型不会调用 API、连接 QQ 或读正式应用的密钥。测试报告与截图写入被 Git 忽略的 `test-results/`。

上游组件复用前，先对原件执行了 17 项隔离检查，包括 debounce 与未采用的 Windows Job 组件、100 次句柄开关以及子进程树清理；再对去抖移植做交叉语言随机流比对。来源记录在 `third_party/maibot/SOURCE.json`。当前程序没有打包或依赖那个 Windows Job 组件。

2026-11-17 本机通过 41 项核心测试、去抖交叉语言比对、Electron 开发版与打包版冒烟，生成 NSIS 与 ZIP 并扫描 asar。最终压力报告：10,000 条消息、2,500 次脚本模型调用、约 14.5 秒，Node 运行进程峰值 RSS 约 83 MiB，关闭后运行状态全部释放。此数值不是整个 Electron 应用的内存，也不是八小时真实时间结果。构建哈希与验证清单见 [verification.json](verification.json)。官方 npm registry 审计报告零项已知漏洞；这不是安全性的完整证明。

本机没有可用 Docker 引擎，已运行的容器检查使用真实请求代码对接模拟 Docker API，不能宣称真实容器隔离已在本机验证。CI 单独提供真实 Linux Docker 验证任务。没有向真实 QQ 发送测试消息。安装器尚未做干净 Windows 虚拟机的完整安装／卸载测试，也未做代码签名。

## 真实模型评测

```powershell
npm run eval
```

默认只列出 30 个合成场景，不调用模型、不读取正式凭据。要明确运行收费的评测：

```powershell
$env:CHATDS_EVAL_PROVIDER='deepseek'
$env:CHATDS_EVAL_BASE_URL='https://api.deepseek.com'
$env:CHATDS_EVAL_MODEL='你的模型名称'
$env:CHATDS_EVAL_API_KEY='仅在当前终端设置你的评测密钥'
npm run eval -- --max-calls=30
Remove-Item Env:CHATDS_EVAL_API_KEY
```

可以用 `--case=burst-vent` 只跑一个场景。`--max-calls` 限制总模型请求数，包括工具后的追加请求，不保证每个场景只用一次。评测经生产 RuntimeCore 与 ModelHost，但禁用后台记忆和外部工具副作用；群消息输出只写入测试记录，不发送到 QQ。

`test-results/evaluation.json` 保存输入、回复、调用数、时间、用量与待人工填写的评分。结构性检查只检查是否产生回复／保持安静，不判定对话自然。请对至少 30 组多轮场景盲评自然度、说话人准确度、延续话题、无关建议和过度括号动作；比较不同模型与旧实现，不要用固定脚本回复的测试充当质量结论。

规划时的少量真实 API 探索曾受测试管道编码与 SDK 输入形状问题影响，失效结果不纳入质量或速度结论。修复后的协议测试使用本地 HTTP 验证精确中文、思考字段与接口密钥绑定。本版本没有完成 30 场景真实模型盲评，不宣称已经达到“像真人”的质量。

## 更长的资源检查

```powershell
npm run build
node --expose-gc scripts/soak.mjs --duration-ms=28800000
```

这会把同一批负载铺到八小时真实时间，仍使用脚本模型。另提供仅手动触发、需要 self-hosted Windows runner 的八小时 workflow；普通 CI 不会自动跑八小时，也不调用收费模型。真实网络与服务的长期稳定性还需单独观察。

## 当前取舍

- 仅 Windows x64 桌面打包；其他系统的核心 CI 不代表完整桌面支持。
- 暂不处理图片内容、语音或自动离线私信；纯图片消息不会触发模型。
- 只支持 OneBot v11 正向 WebSocket；不托管 NapCat 进程，不代替用户登录。
- 模型需要 OpenAI Chat Completions 风格的文本与工具调用；未适配所有厂商特有 reasoning 协议。
- SQLite 同步操作放在独立运行进程，仍可能在大规模数据库维护时短暂阻塞该进程；历史界面默认展示最近 100 条。
- 事实提取与摘要有模型语义误判风险；没有自动判断任意记忆“绝对真实”的机制。
- 每日预算依赖供应商 usage 和本地估计，已在途请求可能有误差；不等于严格金额限额。
- QQ 空间接口实验性，服务变动可能导致失败；所有未知发布结果均应人工核实。
