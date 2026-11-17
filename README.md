# ChatDS Desktop

一个在本机运行的 Windows 聊天伙伴。默认纯陪伴；需要办事时，手动为当前会话切换到受控助理。支持桌面聊天与外部 OneBot v11 服务，NapCat 由用户自行安装、登录。

项目正在验证首个版本。运行机制与权限边界有自动化测试；聊天是否自然仍需要真实模型的多轮评测。

## 开始使用

从本仓库的 GitHub Actions → `Checks and Windows build` → `ChatDS-Windows-x64` 下载构建产物；本机构建的安装程序在 `release/`。安装版与 ZIP 版使用同一份 `%APPDATA%\ChatDS` 数据。首次发布包未做 Windows 代码签名。

1. 打开「设置」，填入模型名称、接口地址、上下文窗口与 API Key，保存后测试连接。兼容 OpenAI Chat Completions 的接口需要支持工具调用；本地模型可取消「接口需要 API Key」。
2. 直接在「聊天」里聊天。无需先配置 QQ 或 Docker。
3. 要接入 QQ，按 [连接说明](docs/configuration.md) 配置你自己安装的 OneBot v11 服务。在「连接」中填写地址、Access Token、机器人 QQ 和你的主号 QQ。
4. 其他私聊对象与群必须加入白名单。群内「无需 @，允许适时插话」默认关闭，按群开启。

密钥由 Electron `safeStorage` 使用 Windows 加密能力保护，界面不会回读明文。更换模型接口地址需要为新地址保存密钥。人设、技能、聊天内容无法修改实际权限。

## 已实现

| 范围       | 行为                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 陪伴       | 合并连续消息，结合说话人、引用与上下文；新消息可中断旧回复；模型可回复、等待或结束，不靠不断自问制造活动 |
| 助理       | 桌面或主号私聊手动开启；读取文件、写入文件、网页阅读、隔离脚本、纯文字说说分别授权                       |
| 权限       | 每次请求刷新 system prompt 中的能力与技能目录；每次工具执行重新检查；写入、执行、发布逐次确认            |
| 人设与技能 | 人设作为风格资料；导入 `SKILL.md` 目录后创建内容快照，按需读取资源，技能不授予权限                       |
| 记忆       | SQLite + 中文分词全文检索；明确「记住」立即保存，可选后台事实提取与对话压缩；有身份、来源与范围          |
| 隔离       | 桌面和主号私聊共享个人记忆；其他人分别保存；每个群独立；任务工具不向群或其他用户开放                     |
| 可见性     | 展示等你说完、回忆、生成、调用工具、等待确认、发送等实际阶段；助理模式可显示草稿                         |
| 生命周期   | 独立运行进程、会话串行、全局并发与队列上限、闲置会话回收、取消传播、连接退避、待确认超时、日志轮转       |
| 迁移       | 手动选择旧版 `fish.json` / `state.json`，先预览、校验哈希、备份再导入；不迁入凭据或个人角色卡            |

默认任务工具全部关闭。QQ群观察与后台记忆会增加模型调用，分别有配额；每日用量包括后台提取与摘要。没有用户离线后的主动私信功能。心情目前由角色对话表达，没有持久心情引擎或虚构的心情工具。

## 从源码运行

开发环境：Windows 10/11 x64、Node.js 24、npm。Python 3.12 只用于上游一致性验证；聊天程序不依赖 Python。

```powershell
git clone git@github.com:Zlongyang/chatds-desktop.git
cd chatds-desktop
npm ci
npm start
```

```powershell
npm test
npm run test:parity
npm run test:smoke
npm run test:soak
npm run dist:win
node scripts/smoke.mjs --packaged
```

`npm run test:soak` 使用脚本模型和加速逻辑时钟，默认写入 10,000 条消息。它不能替代连续八小时真实服务测试。复现、模型评测和实测边界见 [验证说明](docs/validation.md)。

## 可选脚本沙箱

安装 Docker Desktop 并启用 Linux 容器后：

```powershell
npm run sandbox:build
node scripts/test-sandbox.mjs
```

在桌面「工具」里检查 Docker，再开启脚本工具。构建脚本记录基础镜像 digest；执行时使用检查得到的固定 image ID。容器断网、非 root、只读根文件系统，使用临时卷与资源上限。输入是工作区副本，不挂载用户目录或 Docker socket。容器输出不会自动覆盖宿主文件。没有 Docker 时脚本执行不可用。

## 进一步了解

- [配置与故障处理](docs/configuration.md)
- [架构与上游取舍](docs/architecture.md)
- [安全边界](SECURITY.md)
- [验证、成本与已知限制](docs/validation.md)
- [参与开发](CONTRIBUTING.md)
- [第三方来源与许可证](THIRD_PARTY_NOTICES.md)

使用 GPL-3.0-only。复用 MaiBot 去抖组件前先验证原实现，再移植并保留对照测试、版本与原始来源；具体记录在 `third_party/maibot/`。Pi 负责模型协议与 agent loop，权限与外部副作用由本项目的宿主 broker 执行。
