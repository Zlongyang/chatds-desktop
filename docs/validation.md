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

## 本机工具实测

2026-11-18 在 Windows 上通过全部 86 项自动化测试。覆盖了更换模型失败时保留原配置、群聊连续补充、跨会话取消隔离、老记录翻页、按机器人账号处理好友申请等场景。另用本机 Docker Desktop 的 Linux 引擎运行真实容器，用公开站点复测网页读取。下表列出模型能调用的全部工具和陪伴动作。

| 工具                                  | 本机验证                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_remember`、`memory_search`    | 使用真实 SQLite，核对明确要求记住的原话、来源消息、读回结果和会话间的权限。                                                                                   |
| `skills_load`                         | 从提示词中的技能 ID 加载安装快照，读取正文及资源，缺失资源会给模型返回错误。                                                                                  |
| `read_file`、`write_file`             | 在临时工作区确认写入后读回原文。拒绝覆写后原文件保留，文件错误仅返回相对路径和错误码。                                                                        |
| `web_read`                            | 当次访问 OpenAI 新闻页返回 HTTP 403，TechCrunch 的 OpenAI 栏目和 example.com 返回正文。数据库和界面按回复记录每个站点的结果。                                 |
| `sandbox_exec`                        | 在真实容器运行 Python 和 JavaScript，验证非特权用户、只读根目录、禁网、标准输出、错误输出、退出码和导出文件的 SHA-256。取消已在运行的脚本后，测试容器数归零。 |
| `qzone_publish`                       | 用本机 OneBot WebSocket 和 HTTP 测试服务验证账号核对、逐次确认、精确正文、错误响应及提交后断线。真实 QQ 账号和空间服务未参与测试。                            |
| `chat_reply`、`chat_wait`、`chat_end` | 回复只投递一次，等待和结束保持静默，三种动作都会结束本轮模型调用。                                                                                            |

DeepSeek 和通用 OpenAI-compatible 两种配置都通过了本地 HTTP 协议测试。测试服务分两段返回工具参数，真实模型 SDK 解析后调用网页工具，下一次请求携带原调用 ID 和对应错误，再将最终回复写入聊天记录。公网和 Docker 的结果分别保存在 `test-results/tools-live-web.json` 和 `test-results/sandbox-real.json`。

NSIS 已在全新 Windows 运行器完成安装、首次配置本机模型、桌面首聊和卸载，卸载后从 SQLite 读回了完整对话。安装包未做代码签名。[Windows 安装验收](https://github.com/Zlongyang/chatds-desktop/actions/runs/44206394064/job/134473310438#step:8:1)

## 从桌面操作复测

先运行 `npm run dist:win`。以下命令使用发布包的普通应用入口和全新临时用户目录。交互从窗口中的表单、聊天框和审批按钮开始。每次运行独立配置模型，正式用户目录与账号无需参与。

```powershell
node scripts/test-tool-journey.mjs --archive release/win-unpacked/resources/app.asar
node scripts/test-qq-chat.mjs --archive release/win-unpacked/resources/app.asar
```

工具测试通过本机 HTTP 模型安排可复现的调用，实际读取或修改临时工作区。选择技能目录时，驱动向原生目录选择器返回测试文件夹。隔离工具按本机 Docker 与镜像状态验证可用或不可用的路径。QQ 测试模拟 NapCat 手机确认、OneBot 对端和模型，检查真实桌面配置、WebSocket 收发、回执与重启后的记录。

真实公网评测需要在当前终端设置 `DEEPSEEK_API_KEY`。下面的命令会产生模型费用，也会访问模型选择的公开网页。脚本从首次启动表单输入密钥，在聊天框询问 Anthropic 近期公告，追问后切换模式并开启网页读取，最后重启并核对可见记录。截图和回复保存在 `test-results` 下。

```powershell
node scripts/test-web-chat.mjs --live --require-official --archive release/win-unpacked/resources/app.asar
```

## 陪伴模式的多轮盲评

`evaluation/replay-cases.json` 包含 6 个合成场景。每轮可以有连续几条消息；运行器等待本轮结束才投递下一轮。合成群消息保留发言人、@ 和引用对象。两组使用相同模型和角色资料，一组运行 ChatDS 的合并、等待、接话逻辑，另一组对每条输入立即作答并保留前文。逐条回复组是用于比较的基线。

先预览场景和调用预算：

```powershell
npm run eval -- --replay --max-calls=0
```

把模型服务、接口、模型名和专用密钥设在当前终端的 `CHATDS_EVAL_PROVIDER`、`CHATDS_EVAL_BASE_URL`、`CHATDS_EVAL_MODEL`、`CHATDS_EVAL_API_KEY`，再运行：

```powershell
npm run eval -- --replay --case=pond --max-calls=12
npm run eval -- --replay --max-calls=50
```

默认每次在 `test-results` 下生成新目录。先打开 `blind-review.md`，逐场看谁在说话、是否接住追问、何时保持安静，在表里填 A、B 或平局并记下一句理由。评完再打开 `answer-key.json` 核对版本。`replay.json` 记录请求次数、每轮动作和技术错误。真实 QQ 验收单独进行，回放使用合成发言和本地消息投递。

2026-11-18 用同一个 `deepseek-flash` 和内置小鱼人设对照了 22 条输入、17 轮对话。最终记录中，陪伴组有 12 条可见回复，逐条回复组有 22 条。两组分别有 17 轮和 12 轮符合场景预设的回复或静默时机。修复昵称和明确要求静默的问题后只重跑了受影响的对照，完整过程共发出 51 次真实模型请求。机器复阅中，「谁的杯子」仍有一次没接住指代。这批记录可以人工盲评，目前没有真人自然度评分。

## 单轮与连发评测

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
- QQ 使用 OneBot v11 正向 WebSocket。选择本机 NapCat 安装目录后，可手动启动支持的 Windows 启动器。登录由用户在手机 QQ 上确认。
- 模型需要 OpenAI Chat Completions 风格的文本与工具调用；未适配所有厂商特有 reasoning 协议。
- SQLite 同步操作放在独立运行进程，大规模维护可能短暂阻塞该进程。聊天页按每页 100 条展示，可翻看更早的消息，也可直接回到最新。
- 事实提取与摘要有模型语义误判风险；没有自动判断任意记忆“绝对真实”的机制。
- 每日预算依赖供应商 usage 和本地估计，已在途请求可能有误差；不等于严格金额限额。
- QQ 空间接口实验性，服务变动可能导致失败；所有未知发布结果均应人工核实。
